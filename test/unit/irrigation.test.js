'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { loadFlow, findNode, createContext, runFunction, ms } = require('../lib/flow')

const flow = loadFlow()
const irrigationTab = findNode(flow, { type: 'tab', label: 'Irrigation' })
const saveSchedule = findNode(flow, { type: 'function', name: 'sqlite query', z: irrigationTab.id, outputs: 2 })
const toggleOneShot = findNode(flow, { type: 'function', name: 'toggle respect one shoot' })

const existing = [
    { id: 1, fromtime: ms('06:00'), totime: ms('09:00') },
    { id: 2, fromtime: ms('18:00'), totime: ms('18:10') }
]

function programming (values) {
    return createContext({ programming: { active: 1, every: 30, duration: 150, oneshoot: 0, conflict: '', ...values } })
}
const flowRate = () => createContext({ irrigation: { config: { flowrate: 36 }, irrprgact: { id: 0 } } }) // 10 ml/s

test('add a repeated schedule in a free slot', async () => {
    const flowCtx = programming({ cmd: 'add', fromtime: ms('12:00'), totime: ms('13:00') })
    const { outputs } = await runFunction(saveSchedule, { payload: existing }, { flow: flowCtx, global: flowRate() })
    assert.equal(outputs[0].length, 0)
    assert.equal(outputs[1][0].topic, `INSERT INTO irrigation(id, active, fromtime, totime, every, duration, oneshoot) VALUES (NULL, 1, ${ms('12:00')}, ${ms('13:00')}, 30, 150, 0);`)
    assert.match(outputs[1][1].topic, /^SELECT .* FROM irrigation ORDER BY fromtime;$/)
})

test('a one shot schedule ends after the time needed to deliver the duration of the form', async () => {
    const flowCtx = programming({ cmd: 'add', oneshoot: 1, duration: 200, fromtime: ms('12:00'), totime: ms('12:00') })
    const { outputs } = await runFunction(saveSchedule, { payload: existing }, { flow: flowCtx, global: flowRate() })
    // 200 ml at 10 ml/s = 20 s
    assert.equal(outputs[1][0].topic, `INSERT INTO irrigation(id, active, fromtime, totime, every, duration, oneshoot) VALUES (NULL, 1, ${ms('12:00')}, ${ms('12:00') + 20000}, 0, 200, 1);`)
})

test('overlapping schedules are refused with a notification', async () => {
    const flowCtx = programming({ cmd: 'add', fromtime: ms('08:00'), totime: ms('10:00') })
    const { outputs } = await runFunction(saveSchedule, { payload: existing }, { flow: flowCtx, global: flowRate() })
    assert.equal(outputs[1].length, 0)
    assert.equal(outputs[0][0].payload, 'Current schedule overlapping schedule id 1, ')
})

test('from time after to time is refused', async () => {
    const flowCtx = programming({ cmd: 'add', fromtime: ms('15:00'), totime: ms('14:00') })
    const { outputs } = await runFunction(saveSchedule, { payload: existing }, { flow: flowCtx, global: flowRate() })
    assert.match(outputs[0][0].payload, /From time cannot be greater than To time/)
})

test('edit can keep the time slot of the edited schedule', async () => {
    const flowCtx = programming({ cmd: 'edit', id: 1, fromtime: ms('06:30'), totime: ms('09:00'), every: 45 })
    const { outputs } = await runFunction(saveSchedule, { payload: existing }, { flow: flowCtx, global: flowRate() })
    assert.equal(outputs[1][0].topic, `UPDATE irrigation SET active = 1, fromtime = ${ms('06:30')}, totime = ${ms('09:00')}, every = 45, duration = 150, oneshoot = 0 WHERE id = 1;`)
})

test('delete sends the query to the database, not to the notification', async () => {
    const global = createContext({ irrigation: { irrprgact: { id: 2 } } })
    const flowCtx = programming({ cmd: 'delete', id: 2 })
    const { outputs } = await runFunction(saveSchedule, { payload: existing }, { flow: flowCtx, global })
    assert.equal(outputs[0].length, 0)
    assert.equal(outputs[1][0].topic, 'DELETE FROM irrigation WHERE id = 2;')
    assert.equal(global.get('irrigation.irrprgact.id'), 0, 'the deleted program is no longer active')
})

test('one shot disables To and Every and computes the end time', async () => {
    const flowCtx = programming({ oneshoot: 1, fromtime: ms('07:15'), duration: 600 })
    const { outputs } = await runFunction(toggleOneShot, {}, { flow: flowCtx, global: flowRate() })
    // 600 ml at 10 ml/s = 60 s
    assert.deepEqual(outputs[0], [{ payload: '07:16', enabled: false }])
    assert.deepEqual(outputs[1], [{ payload: null, enabled: false }])
})

test('repeated schedules enable To and Every without changing them', async () => {
    const { outputs } = await runFunction(toggleOneShot, {}, { flow: programming({ oneshoot: 0 }), global: flowRate() })
    assert.deepEqual(outputs, [[{ enabled: true }], [{ enabled: true }]])
})
