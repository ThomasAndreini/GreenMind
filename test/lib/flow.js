'use strict'
// Helpers to load greenmind.json and run the code of its function nodes outside Node-RED.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const FLOW_FILE = path.join(__dirname, '..', '..', 'greenmind.json')

function loadFlow () {
    return JSON.parse(fs.readFileSync(FLOW_FILE, 'utf8'))
}

/** Find exactly one node matching the filter, fail otherwise */
function findNode (flow, filter) {
    const found = flow.filter(n => Object.entries(filter).every(([k, v]) => n[k] === v))
    if (found.length !== 1) {
        throw new Error(`expected one node matching ${JSON.stringify(filter)}, found ${found.length}`)
    }
    return found[0]
}

/** Split a context key like "a.b[0].c" in ["a", "b", 0, "c"] */
function splitKey (key) {
    return key.replace(/\[(\d+)\]/g, '.$1').split('.').map(k => (/^\d+$/.test(k) ? Number(k) : k))
}

/** In-memory context with the same dotted-path semantics of Node-RED flow/global context */
function createContext (initial = {}) {
    const data = structuredClone(initial)
    return {
        data,
        get (key) {
            return splitKey(key).reduce((obj, k) => (obj === undefined || obj === null ? undefined : obj[k]), data)
        },
        set (key, value) {
            const keys = splitKey(key)
            let obj = data
            keys.slice(0, -1).forEach((k, i) => {
                if (obj[k] === undefined || obj[k] === null) obj[k] = typeof keys[i + 1] === 'number' ? [] : {}
                obj = obj[k]
            })
            if (value === undefined) delete obj[keys[keys.length - 1]]
            else obj[keys[keys.length - 1]] = value
        }
    }
}

/**
 * Run a function node with msg. Returns the messages sent per output:
 * [[msgs of output 1], [msgs of output 2], ...] (returned and node.send() messages, in order).
 * Timers are run immediately so delayed sends are collected too.
 */
async function runFunction (fnNode, msg, { flow = createContext(), global = createContext(), now } = {}) {
    const outputs = Array.from({ length: fnNode.outputs || 1 }, () => [])
    const collect = (result) => {
        if (result === null || result === undefined) return
        const arr = Array.isArray(result) ? result : [result]
        arr.forEach((m, i) => {
            if (m === null || m === undefined) return
            (Array.isArray(m) ? m : [m]).forEach(x => outputs[i].push(structuredClone(x)))
        })
    }
    const warnings = []
    const node = {
        send: collect,
        warn: (w) => warnings.push(w),
        error: (e) => { throw new Error(String(e)) },
        status: () => {},
        log: () => {}
    }
    const timers = []
    const sandbox = {
        node,
        flow,
        global,
        env: { get: () => undefined },
        console,
        Math,
        JSON,
        Number,
        String,
        Buffer,
        setTimeout: (fn) => timers.push(fn),
        clearTimeout: () => {},
        Date: now === undefined ? Date : fakeDate(now)
    }
    for (const lib of fnNode.libs || []) {
        sandbox[lib.var] = require(lib.module)
    }
    const code = `(async function (msg) {\n${fnNode.func}\n})`
    const fn = vm.runInNewContext(code, sandbox, { filename: `function:${fnNode.name || fnNode.id}` })
    collect(await fn(structuredClone(msg)))
    while (timers.length) timers.shift()()
    return { outputs, warnings, flow, global }
}

/** A Date class whose "now" is fixed to the given local time ("HH:mm" or epoch ms) */
function fakeDate (now) {
    let fixed = now
    if (typeof now === 'string') {
        const [h, m] = now.split(':').map(Number)
        const d = new Date()
        d.setHours(h, m, 0, 0)
        fixed = d.getTime()
    }
    return class extends Date {
        constructor (...args) {
            if (args.length === 0) super(fixed)
            else super(...args)
        }

        static now () {
            return fixed
        }
    }
}

/** ms from midnight for "HH:mm", the unit used by the schedules */
function ms (hhmm) {
    const [h, m] = hhmm.split(':').map(Number)
    return (h * 60 + m) * 60000
}

module.exports = { loadFlow, findNode, createContext, runFunction, ms, FLOW_FILE }
