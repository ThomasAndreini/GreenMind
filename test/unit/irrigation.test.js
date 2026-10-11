'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { loadFlow, findNode, createContext, runFunction, ms } = require('../lib/flow')

const flow = loadFlow()
const saveIrrigation = findNode(flow, { type: 'function', name: 'save irrigation schedule' })
const saveClimate = findNode(flow, { type: 'function', name: 'save climate schedule' })
const toggleOneShot = findNode(flow, { type: 'function', name: 'toggle respect one shoot' })

const existing = [
    { id: 1, fromtime: ms('06:00'), totime: ms('09:00') },
    { id: 2, fromtime: ms('18:00'), totime: ms('18:10') }
]

function programming (values) {
    return createContext({ programming: { active: 1, every: 30, duration: 150, oneshoot: 0, conflict: '', ...values } })
}
const flowRate = () => createContext({ irrigation: { config: { flowrate: 36 }, irrprgact: { id: 0 } } }) // 10 ml/s

/** sqlite node in "msg.topic" mode binds msg.payload when it has one value for each $ parameter */
function assertBound (msg) {
    assert.equal(msg.topic.split('$').length - 1, msg.payload.length, `parameters of ${msg.topic}`)
}

async function save (fn, values, { global = flowRate(), rows = existing } = {}) {
    const { outputs } = await runFunction(fn, { topic: 'SELECT id, fromtime, totime FROM t;', payload: rows }, { flow: programming(values), global })
    outputs[1].forEach(assertBound)
    return { notify: outputs[0].map(m => m.payload), db: outputs[1], global }
}

test('add a repeated schedule in a free slot', async () => {
    const { notify, db } = await save(saveIrrigation, { cmd: 'add', fromtime: ms('12:00'), totime: ms('13:00') })
    assert.deepEqual(notify, [])
    assert.equal(db[0].topic, 'INSERT INTO irrigation(active, fromtime, totime, every, duration, oneshoot) VALUES ($1, $2, $3, $4, $5, $6);')
    assert.deepEqual(db[0].payload, [1, ms('12:00'), ms('13:00'), 30, 150, 0])
    assert.match(db[1].topic, /^SELECT .* FROM irrigation ORDER BY fromtime;$/)
})

test('a one shot schedule ends after the time needed to deliver the duration of the form', async () => {
    const { db } = await save(saveIrrigation, { cmd: 'add', oneshoot: 1, duration: 200, every: null, fromtime: ms('12:00'), totime: ms('12:00') })
    // 200 ml at 10 ml/s = 20 s
    assert.deepEqual(db[0].payload, [1, ms('12:00'), ms('12:00') + 20000, 0, 200, 1])
})

test('overlapping schedules are refused with a notification', async () => {
    const { notify, db } = await save(saveIrrigation, { cmd: 'add', fromtime: ms('08:00'), totime: ms('18:05') })
    assert.deepEqual(db, [])
    assert.deepEqual(notify, ['Current schedule overlapping schedule id 1, 2'])
})

test('invalid values are refused before reaching the database', async () => {
    const cases = [
        [{ cmd: 'add', fromtime: ms('15:00'), totime: ms('14:00') }, /From time cannot be greater than To time/],
        [{ cmd: 'add', fromtime: undefined, totime: ms('14:00') }, /Set the From and To time/],
        [{ cmd: 'add', fromtime: ms('12:00'), totime: ms('13:00'), every: 0 }, /Every must be at least 1 minute/],
        [{ cmd: 'add', fromtime: ms('12:00'), totime: ms('13:00'), duration: 0 }, /Duration must be greater than 0/],
        [{ cmd: 'add', fromtime: ms('12:00'), totime: ms('13:00'), every: '1; DROP TABLE irrigation' }, /Every must be at least 1 minute/],
        [{ cmd: 'edit', fromtime: ms('12:00'), totime: ms('13:00') }, /Select a schedule in the table first/]
    ]
    for (const [values, message] of cases) {
        const { notify, db } = await save(saveIrrigation, values)
        assert.deepEqual(db, [], JSON.stringify(values))
        assert.match(notify[0], message)
    }
})

test('a one shot schedule needs the flow rate', async () => {
    const { notify } = await save(saveIrrigation, { cmd: 'add', oneshoot: 1, fromtime: ms('12:00'), totime: ms('12:00') },
        { global: createContext({ irrigation: { config: { flowrate: 0 } } }) })
    assert.match(notify[0], /Set the flow rate/)
})

test('edit can keep the time slot of the edited schedule and reloads the active program', async () => {
    const global = createContext({ irrigation: { config: { flowrate: 36 }, irrprgact: { id: 1 } } })
    const { db } = await save(saveIrrigation, { cmd: 'edit', id: 1, fromtime: ms('06:30'), totime: ms('09:00'), every: 45 }, { global })
    assert.equal(db[0].topic, 'UPDATE irrigation SET active = $1, fromtime = $2, totime = $3, every = $4, duration = $5, oneshoot = $6 WHERE id = $7;')
    assert.deepEqual(db[0].payload, [1, ms('06:30'), ms('09:00'), 45, 150, 0, 1])
    assert.equal(global.get('irrigation.irrprgact.id'), 0)
})

test('delete sends the query to the database, not to the notification', async () => {
    const global = createContext({ irrigation: { irrprgact: { id: 2 } } })
    const { notify, db } = await save(saveIrrigation, { cmd: 'delete', id: 2 }, { global })
    assert.deepEqual(notify, [])
    assert.equal(db[0].topic, 'DELETE FROM irrigation WHERE id = $1;')
    assert.deepEqual(db[0].payload, [2])
    assert.equal(global.get('irrigation.irrprgact.id'), 0, 'the deleted program is no longer active')
})

test('climate: add, edit and delete use parameters', async () => {
    const limits = { tempmin: 18, tempmax: 26, hummin: 40, hummax: 70 }
    const added = await save(saveClimate, { cmd: 'new', fromtime: ms('10:00'), totime: ms('17:00'), ...limits })
    assert.equal(added.db[0].topic, 'INSERT INTO climate_set(active, fromtime, totime, tempmin, tempmax, hummin, hummax) VALUES ($1, $2, $3, $4, $5, $6, $7);')
    assert.deepEqual(added.db[0].payload, [1, ms('10:00'), ms('17:00'), 18, 26, 40, 70])
    const edited = await save(saveClimate, { cmd: 'edit', id: 1, fromtime: ms('06:00'), totime: ms('09:00'), ...limits })
    assert.deepEqual(edited.db[0].payload, [1, ms('06:00'), ms('09:00'), 18, 26, 40, 70, 1])
    const deleted = await save(saveClimate, { cmd: 'delete', id: 1 })
    assert.deepEqual(deleted.db[0].payload, [1])
})

test('climate: invalid limits are refused', async () => {
    const base = { cmd: 'new', fromtime: ms('10:00'), totime: ms('17:00'), tempmin: 18, tempmax: 26, hummin: 40, hummax: 70 }
    for (const [values, message] of [
        [{ tempmin: 30 }, /T min cannot be greater than T max/],
        [{ hummin: 80 }, /RH min cannot be greater than RH max/],
        [{ tempmax: undefined }, /Set temperature and humidity limits/],
        [{ fromtime: ms('17:00') }, /From time cannot be greater than To time/],
        [{ fromtime: ms('08:00') }, /overlapping schedule id 1/]
    ]) {
        const { notify, db } = await save(saveClimate, { ...base, ...values })
        assert.deepEqual(db, [], JSON.stringify(values))
        assert.match(notify[0], message)
    }
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
