/**
 * 静态检查：删掉管理块后，app.js 里是否有"被调用但没定义"的函数残留。
 * 这类残留不会在语法检查里报错（node --check 只查语法），
 * 但页面一渲染到那个分支就会抛 ReferenceError，表现为"页面打不开"。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const file = process.argv[2] || path.join(process.env.TEMP || "/tmp", "live-app.js");
const source = await readFile(file, "utf8");

const called = new Set();
for (const match of source.matchAll(/(?<![.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)) called.add(match[1]);

const defined = new Set();
for (const match of source.matchAll(/function\s+([a-zA-Z_$][\w$]*)/g)) defined.add(match[1]);
for (const match of source.matchAll(/(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=/g)) defined.add(match[1]);
// 函数参数与解构出来的名字也算已定义
for (const match of source.matchAll(/\(([^)]*)\)\s*(?:=>|\{)/g)) {
    for (const part of match[1].split(",")) {
        const name = part.trim().split(/[\s=:]/)[0];
        if (/^[a-zA-Z_$][\w$]*$/.test(name)) defined.add(name);
    }
}
for (const match of source.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of match[1].split(",")) {
        const name = part.trim().split(/[\s=:]/)[0];
        if (/^[a-zA-Z_$][\w$]*$/.test(name)) defined.add(name);
    }
}

// 只挑本文件风格的自定义函数：小驼峰、长度 > 5，排除 DOM/Browser API 噪音
const browser = new Set([
    "addEventListener", "removeEventListener", "dispatchEvent", "querySelector", "querySelectorAll",
    "getElementById", "createElement", "appendChild", "insertBefore", "removeChild", "replaceChild",
    "setAttribute", "getAttribute", "removeAttribute", "hasAttribute", "classList", "closest", "matches",
    "requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "setInterval", "clearTimeout",
    "clearInterval", "queueMicrotask", "structuredClone", "encodeURIComponent", "decodeURIComponent",
    "parseInt", "parseFloat", "isNaN", "isFinite", "getComputedStyle", "matchMedia", "createDocumentFragment",
    "createTextNode", "getBoundingClientRect", "scrollIntoView", "focus", "blur", "click", "submit", "reset",
    "preventDefault", "stopPropagation", "stopImmediatePropagation", "showModal", "close", "reportValidity",
    "setSelectionRange", "select", "checkValidity", "toBlob", "createObjectURL", "revokeObjectURL",
    "arrayBuffer", "textContent", "innerHTML", "outerHTML", "insertAdjacentHTML", "remove", "add", "delete",
    "has", "get", "set", "keys", "values", "entries", "forEach", "map", "filter", "reduce", "find", "findIndex",
    "some", "every", "sort", "reverse", "slice", "splice", "concat", "join", "split", "replace", "replaceAll",
    "trim", "trimStart", "trimEnd", "padStart", "padEnd", "startsWith", "endsWith", "includes", "indexOf",
    "lastIndexOf", "toLowerCase", "toUpperCase", "normalize", "toString", "valueOf", "toFixed", "toPrecision",
    "toISOString", "toLocaleString", "toLocaleDateString", "toLocaleTimeString", "getTime", "getFullYear",
    "getMonth", "getDate", "getHours", "getMinutes", "getSeconds", "getDay", "setFullYear", "setMonth", "setDate",
    "localeCompare", "format", "formatToParts", "resolvedOptions", "json", "blob", "formData", "clone",
    "then", "catch", "finally", "all", "allSettled", "race", "resolve", "reject", "abort", "parse", "stringify",
    "isArray", "from", "of", "assign", "freeze", "entries", "values", "keys", "now", "max", "min", "round",
    "floor", "ceil", "abs", "pow", "sqrt", "random", "sign", "trunc", "test", "exec", "match", "matchAll",
    "search", "at", "flat", "flatMap", "fill", "copyWithin", "keys", "values", "getOwnPropertyNames",
    "defineProperty", "create", "getPrototypeOf", "setPrototypeOf", "hasOwnProperty", "isPrototypeOf",
    "toJSON", "postMessage", "close", "open", "write", "writeln", "importScripts", "skipWaiting",
    "waitUntil", "respondWith", "matchAll", "json", "text", "put", "getAll", "count", "deleteAll",
    "captureStackTrace", "console", "alert", "confirm", "prompt", "print", "scrollTo", "scrollBy",
    "load", "save", "reset", "clear", "update", "render", "init", "start", "stop", "run", "boot"
]);

const suspicious = [...called]
    .filter((name) => /^[a-z][a-zA-Z0-9]*$/.test(name) && name.length > 5)
    .filter((name) => !defined.has(name) && !browser.has(name))
    .sort();

if (suspicious.length) {
    console.log(`可疑的未定义调用（共 ${suspicious.length} 个）：`);
    for (const name of suspicious) console.log(`  ${name}`);
    process.exitCode = 1;
} else {
    console.log("未发现悬空函数调用：删除管理块后没有残留引用");
}
