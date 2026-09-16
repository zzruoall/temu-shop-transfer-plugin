/**
 * 自动入库排队纯逻辑。后台负责落盘和 chrome.alarms，这里只处理多任务去重、到期选择和退避。
 * 旧版只存一份 pendingIngestV1，后一次采集会覆盖前一次失败任务，且没有定时唤醒。
 */
var TemuIngestQueue = (function () {
    "use strict";

    var MAX_JOBS = 10;
    var MAX_ATTEMPTS = 5;
    var ALARM_NAME = "pending-ingest-retry";
    var QUEUE_KEY = "pendingIngestQueueV1";
    var LEGACY_KEY = "pendingIngestV1";
    var BACKOFF_MS = [30000, 30000, 60000, 120000, 240000];
    var OUTCOME_KEY = "lastIngestOutcomesV1";
    var MAX_OUTCOMES = 20;

    function asText(value) {
        return String(value == null ? "" : value).trim();
    }

    function uniqueTexts(values) {
        var seen = {};
        var result = [];
        (Array.isArray(values) ? values : []).forEach(function (value) {
            var text = asText(value);
            if (!text || seen[text]) return;
            seen[text] = true;
            result.push(text);
        });
        return result;
    }

    /** 用稳定指纹识别同一批采集，避免同一 SPU 集合重复排队。 */
    function fingerprintJob(job) {
        var eventIds = uniqueTexts(job && job.eventIds).sort();
        var allowedSpuIds = uniqueTexts(job && job.allowedSpuIds).sort();
        return eventIds.join(",") + "|" + allowedSpuIds.join(",");
    }

    function hashFingerprint(value) {
        var text = String(value || "");
        var hash = 5381;
        var index = 0;
        for (index = 0; index < text.length; index += 1) {
            hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
        }
        return (hash >>> 0).toString(16);
    }

    function backoffMs(attempts) {
        var step = Number(attempts);
        if (!Number.isFinite(step) || step < 1) step = 1;
        var index = Math.min(step - 1, BACKOFF_MS.length - 1);
        return BACKOFF_MS[Math.max(0, index)];
    }

    function normalizeJob(raw, nowMs) {
        var now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
        var eventIds = uniqueTexts(raw && raw.eventIds);
        var allowedSpuIds = uniqueTexts(raw && raw.allowedSpuIds);
        var fingerprint = fingerprintJob({ eventIds: eventIds, allowedSpuIds: allowedSpuIds });
        var attempts = Math.max(0, Number(raw && raw.attempts) || 0);
        var createdAt = asText(raw && raw.createdAt) || new Date(now).toISOString();
        var nextAttemptAt = asText(raw && raw.nextAttemptAt);
        if (!nextAttemptAt) nextAttemptAt = new Date(now).toISOString();
        return {
            id: asText(raw && raw.id) || ("ingest-" + hashFingerprint(fingerprint)),
            fingerprint: fingerprint,
            eventIds: eventIds,
            allowedSpuIds: allowedSpuIds,
            saved: Math.max(0, Number(raw && raw.saved) || 0),
            productEvents: Math.max(0, Number(raw && raw.productEvents) || 0),
            createdAt: createdAt,
            attempts: attempts,
            nextAttemptAt: nextAttemptAt,
            lastError: asText(raw && raw.lastError).slice(0, 160),
            lastAttemptAt: asText(raw && raw.lastAttemptAt)
        };
    }

    function isUsableJob(job) {
        return Boolean(job && job.id && job.eventIds.length && job.allowedSpuIds.length);
    }

    /**
     * 把旧的单任务字段迁进队列。单对象不能当数组读，否则会丢掉重试现场。
     */
    function migrateLegacyJobs(queueValue, legacyValue, nowMs) {
        var jobs = [];
        if (Array.isArray(queueValue)) {
            queueValue.forEach(function (item) {
                var job = normalizeJob(item, nowMs);
                if (isUsableJob(job)) jobs.push(job);
            });
        }
        if (legacyValue && typeof legacyValue === "object" && !Array.isArray(legacyValue)) {
            jobs = upsertJob(jobs, legacyValue, nowMs);
        }
        return jobs;
    }

    function upsertJob(jobs, incoming, nowMs) {
        return upsertJobWithEviction(jobs, incoming, nowMs).jobs;
    }

    /**
     * 队列最多保留 10 个任务。超出时淘汰最早的任务，调用方必须把淘汰写成可见终态，
     * 不能再静默丢掉，否则页面会把“当前任务失败”显示成“别人还在排队”。
     */
    function upsertJobWithEviction(jobs, incoming, nowMs) {
        var job = normalizeJob(incoming, nowMs);
        var next = Array.isArray(jobs) ? jobs.slice() : [];
        var evicted = [];
        var index;
        if (!isUsableJob(job)) return { jobs: next, evicted: evicted };
        index = next.findIndex(function (item) {
            return item.id === job.id || item.fingerprint === job.fingerprint;
        });
        if (index >= 0) {
            next[index] = mergeQueuedJob(next[index], job);
        } else {
            next.push(job);
            next.sort(function (left, right) {
                return String(left.createdAt).localeCompare(String(right.createdAt));
            });
            while (next.length > MAX_JOBS) evicted.push(next.shift());
        }
        return { jobs: next, evicted: evicted };
    }


    /**
     * 同一采集指纹再次入队时，只更新商品范围和计数，不能清掉已有重试次数和退避。
     * 再次入队通常不带更高 attempts，normalizeJob 会把次数当成 0；若直接覆盖，失败中的任务会被立刻再打。
     * 只有 markRetry 提高 attempts 时，才改退避字段。
     */
    function mergeQueuedJob(existing, incoming) {
        var merged = Object.assign({}, existing, incoming, {
            createdAt: existing.createdAt || incoming.createdAt,
            id: existing.id || incoming.id
        });
        if ((Number(existing.attempts) || 0) >= (Number(incoming.attempts) || 0)) {
            merged.attempts = existing.attempts;
            merged.nextAttemptAt = existing.nextAttemptAt;
            merged.lastError = existing.lastError;
            merged.lastAttemptAt = existing.lastAttemptAt;
        }
        return merged;
    }

    function removeJob(jobs, jobId) {
        var id = asText(jobId);
        return (Array.isArray(jobs) ? jobs : []).filter(function (job) {
            return job && job.id !== id;
        });
    }

    function nextDueJob(jobs, nowMs) {
        var now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
        var due = (Array.isArray(jobs) ? jobs : []).filter(function (job) {
            if (!isUsableJob(job) || job.attempts >= MAX_ATTEMPTS) return false;
            var when = Date.parse(job.nextAttemptAt || "") || 0;
            return when <= now;
        }).sort(function (left, right) {
            return String(left.createdAt).localeCompare(String(right.createdAt));
        });
        return due[0] || null;
    }

    function nextWakeAt(jobs, nowMs) {
        var now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
        var times = (Array.isArray(jobs) ? jobs : []).map(function (job) {
            if (!isUsableJob(job) || job.attempts >= MAX_ATTEMPTS) return 0;
            return Date.parse(job.nextAttemptAt || "") || 0;
        }).filter(function (value) {
            return value > now;
        }).sort(function (left, right) {
            return left - right;
        });
        return times[0] || 0;
    }

    function markRetry(job, errorCode, nowMs) {
        var now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
        var attempts = Math.max(0, Number(job && job.attempts) || 0) + 1;
        return normalizeJob(Object.assign({}, job, {
            attempts: attempts,
            lastError: asText(errorCode).slice(0, 160),
            lastAttemptAt: new Date(now).toISOString(),
            nextAttemptAt: new Date(now + backoffMs(attempts)).toISOString()
        }), now);
    }

    function summarizeQueue(jobs, nowMs) {
        var list = Array.isArray(jobs) ? jobs : [];
        return {
            pendingCount: list.length,
            maxAttempts: MAX_ATTEMPTS,
            nextJob: nextDueJob(list, nowMs) || list[0] || null,
            nextWakeAt: nextWakeAt(list, nowMs)
        };
    }

    function normalizeOutcome(raw, nowMs) {
        var now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
        var status = asText(raw && raw.status);
        if (status !== "done" && status !== "error") status = "error";
        return {
            fingerprint: asText(raw && raw.fingerprint),
            jobId: asText(raw && raw.jobId),
            status: status,
            error: asText(raw && raw.error).slice(0, 160),
            batchId: asText(raw && raw.batchId),
            reused: Boolean(raw && raw.reused),
            reason: asText(raw && raw.reason).slice(0, 80),
            finishedAt: asText(raw && raw.finishedAt) || new Date(now).toISOString()
        };
    }

    /**
     * 按 fingerprint 保存入库终态。任务成功、永久失败或溢出淘汰后都会离开队列，
     * 页面只能靠这份记录判断当前任务是成功还是失败。
     */
    function upsertOutcome(outcomes, incoming, nowMs) {
        var outcome = normalizeOutcome(incoming, nowMs);
        var next = Array.isArray(outcomes) ? outcomes.filter(function (item) {
            return item && item.fingerprint && item.fingerprint !== outcome.fingerprint;
        }) : [];
        if (!outcome.fingerprint) return next;
        next.push(outcome);
        next.sort(function (left, right) {
            return String(left.finishedAt).localeCompare(String(right.finishedAt));
        });
        while (next.length > MAX_OUTCOMES) next.shift();
        return next;
    }

    function findOutcome(outcomes, fingerprint) {
        var key = asText(fingerprint);
        if (!key) return null;
        return (Array.isArray(outcomes) ? outcomes : []).find(function (item) {
            return item && item.fingerprint === key;
        }) || null;
    }

    /**
     * 队列终态只认仓库真实回执。空包、无商品、没有批次号都不能写成 done，
     * 否则侧栏会显示“已入库”，但网站并没有收到商品。
     */
    function outcomeStatusFromPushResult(result) {
        var skipped = Boolean(result && result.skipped);
        var reason = asText(result && result.reason);
        var batchId = asText(result && (result.batchId || (result.batch && result.batch.id)));
        var reused = Boolean(result && result.reused);
        if (!skipped && (batchId || reused)) {
            return {
                status: "done",
                error: "",
                reason: reused ? "reused" : "ingested",
                batchId: batchId,
                reused: reused
            };
        }
        return {
            status: "error",
            error: reason || "ingest_incomplete",
            reason: reason || "ingest_incomplete",
            batchId: "",
            reused: false
        };
    }

    var api = {
        MAX_JOBS: MAX_JOBS,
        MAX_ATTEMPTS: MAX_ATTEMPTS,
        ALARM_NAME: ALARM_NAME,
        QUEUE_KEY: QUEUE_KEY,
        LEGACY_KEY: LEGACY_KEY,
        OUTCOME_KEY: OUTCOME_KEY,
        MAX_OUTCOMES: MAX_OUTCOMES,
        backoffMs: backoffMs,
        fingerprintJob: fingerprintJob,
        normalizeJob: normalizeJob,
        migrateLegacyJobs: migrateLegacyJobs,
        upsertJob: upsertJob,
        upsertJobWithEviction: upsertJobWithEviction,
        removeJob: removeJob,
        nextDueJob: nextDueJob,
        nextWakeAt: nextWakeAt,
        markRetry: markRetry,
        summarizeQueue: summarizeQueue,
        isUsableJob: isUsableJob,
        normalizeOutcome: normalizeOutcome,
        upsertOutcome: upsertOutcome,
        findOutcome: findOutcome,
        outcomeStatusFromPushResult: outcomeStatusFromPushResult
    };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    return api;
}());
