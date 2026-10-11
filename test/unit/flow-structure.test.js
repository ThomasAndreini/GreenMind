'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { loadFlow } = require('../lib/flow')

const flow = loadFlow()
const byId = new Map(flow.map(n => [n.id, n]))

// node types provided by Node-RED core and by the dependencies in package.json
const KNOWN_TYPES = new Set([
    'tab', 'group', 'comment', 'inject', 'function', 'change', 'switch', 'delay', 'catch', 'complete',
    'link in', 'link out', 'http request',
    'sqlite', 'sqlitedb', 'rpi-gpio out',
    'ui-base', 'ui-theme', 'ui-page', 'ui-group', 'ui-button', 'ui-chart', 'ui-control', 'ui-dropdown',
    'ui-notification', 'ui-number-input', 'ui-switch', 'ui-table', 'ui-template', 'ui-text', 'ui-text-input'
])

test('node ids are unique', () => {
    assert.equal(byId.size, flow.length)
})

test('only known node types are used (no legacy dashboard nodes)', () => {
    const unknown = [...new Set(flow.map(n => n.type))].filter(t => !KNOWN_TYPES.has(t))
    assert.deepEqual(unknown, [])
})

test('every wire and link points to an existing node', () => {
    for (const n of flow) {
        for (const out of n.wires || []) {
            for (const target of out) assert.ok(byId.has(target), `${n.type} ${n.id} wired to missing ${target}`)
        }
        for (const target of n.links || []) assert.ok(byId.has(target), `${n.type} ${n.id} linked to missing ${target}`)
    }
})

test('every node lives in an existing tab', () => {
    for (const n of flow.filter(n => n.z)) assert.equal(byId.get(n.z)?.type, 'tab', `${n.type} ${n.id}`)
})

test('dashboard widgets, groups and pages are connected', () => {
    for (const n of flow.filter(n => n.type.startsWith('ui-') && 'group' in n)) {
        assert.equal(byId.get(n.group)?.type, 'ui-group', `${n.type} ${n.id} group`)
    }
    for (const g of flow.filter(n => n.type === 'ui-group')) {
        assert.equal(byId.get(g.page)?.type, 'ui-page', `group ${g.name} page`)
        assert.ok(Number(g.width) <= 12, `group ${g.name} must fit the 12 columns desktop grid`)
    }
    for (const p of flow.filter(n => n.type === 'ui-page')) {
        assert.equal(byId.get(p.ui)?.type, 'ui-base', `page ${p.name} ui`)
        assert.equal(p.layout, 'grid')
    }
    for (const n of flow.filter(n => ['ui-control', 'ui-notification'].includes(n.type))) {
        assert.equal(byId.get(n.ui)?.type, 'ui-base', `${n.type} ${n.id} ui`)
    }
})

test('widgets fit their group width', () => {
    for (const n of flow.filter(n => n.type.startsWith('ui-') && 'group' in n)) {
        const group = byId.get(n.group)
        assert.ok(Number(n.width) <= Number(group.width), `${n.type} ${n.label || n.id} width ${n.width} > group ${group.width}`)
    }
})

test('tables switch to the mobile layout on narrow screens', () => {
    for (const t of flow.filter(n => n.type === 'ui-table')) {
        assert.equal(t.mobileBreakpointType, 'px')
        assert.ok(Number(t.mobileBreakpoint) >= 400)
        assert.equal(t.action, 'replace')
    }
})

test('every function node compiles', () => {
    for (const f of flow.filter(n => n.type === 'function')) {
        assert.doesNotThrow(() => new vm.Script(`(async function (msg) {\n${f.func}\n})`), `function ${f.name || f.id}`)
    }
})

test('every JSONata expression compiles', () => {
    // Node-RED 5 bundles JSONata in @node-red/util
    const jsonata = require('@node-red/util/lib/jsonata.js')
    const exprs = []
    for (const n of flow) {
        if (n.type === 'change') n.rules.filter(r => r.tot === 'jsonata').forEach(r => exprs.push([n.id, r.to]))
        if (n.type === 'ui-text' && n.valueType === 'jsonata') exprs.push([n.id, n.value])
    }
    assert.ok(exprs.length > 0)
    for (const [id, expr] of exprs) assert.doesNotThrow(() => jsonata(expr), `${id}: ${expr}`)
})

test('the development Test flow is disabled', () => {
    const tab = flow.find(n => n.type === 'tab' && n.label === 'Test')
    assert.equal(tab.disabled, true)
})

test('all sqlite nodes use the GreenMind database', () => {
    const dbs = flow.filter(n => n.type === 'sqlitedb')
    assert.equal(dbs.length, 1)
    for (const s of flow.filter(n => n.type === 'sqlite')) assert.equal(s.mydb, dbs[0].id)
})
