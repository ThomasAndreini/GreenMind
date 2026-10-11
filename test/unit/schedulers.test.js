'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { loadFlow, findNode, createContext, runFunction, ms } = require('../lib/flow')

const flow = loadFlow()
const irrigation = findNode(flow, { type: 'function', name: 'check irrigation program and execute it' })
const climate = findNode(flow, { type: 'function', name: 'check climate program and execute it' })

/** absolute epoch ms of today at HH:mm[:ss] (local time) */
function at (hhmmss, dayOffset = 0) {
    const [h, m, s = 0] = hhmmss.split(':').map(Number)
    const d = new Date()
    d.setDate(d.getDate() + dayOffset)
    d.setHours(h, m, s, 0)
    return d.getTime()
}

// ---------------------------------------------------------------------------
// Irrigation
// ---------------------------------------------------------------------------
const repeated = { id: 1, active: 1, fromtime: ms('06:00'), totime: ms('09:00'), every: 30, duration: 150, oneshoot: 0 }
const oneShot = { id: 2, active: 1, fromtime: ms('18:00'), totime: ms('18:00') + 15000, every: 0, duration: 150, oneshoot: 1 }

function irrigationState (extra = {}) {
    return createContext({
        irrigation: {
            irrisact: 0, irrtime: 0, manualirrigation: 0, everytime: 0,
            irrprgact: { id: 0 }, output: { levelirr: 0 }, config: { flowrate: 36 }, // 10 ml/s
            ...extra
        }
    })
}

/** run the irrigation scheduler at the given times, returns the messages sent to the pin and to the db */
async function runIrrigation (times, { global = irrigationState(), schedules = [repeated, oneShot] } = {}) {
    const flowCtx = createContext({ cache: { irrigation: schedules } })
    const pin = []
    const db = []
    for (const t of times) {
        const { outputs } = await runFunction(irrigation, {}, { flow: flowCtx, global, now: at(t) })
        outputs[0].forEach(m => pin.push([t, m.payload]))
        outputs[1].forEach(m => db.push([t, m.topic]))
    }
    return { pin, db, global }
}

test('irrigation: a repeated program starts at once and stops after the duration', async () => {
    const { pin, db } = await runIrrigation(['05:59:59', '06:00:00', '06:00:01', '06:00:10', '06:00:16'])
    assert.deepEqual(pin, [['06:00:01', 1], ['06:00:16', 0]])
    assert.equal(db.length, 1)
    assert.match(db[0][1], /^INSERT INTO irrigationdone\(id, time, duration\) VALUES \(NULL, \d+, 150\);$/)
})

test('irrigation: the next run starts after "every" minutes', async () => {
    const { pin } = await runIrrigation(['06:00:00', '06:00:01', '06:00:16', '06:20:00', '06:30:16', '06:30:17'])
    assert.deepEqual(pin, [['06:00:01', 1], ['06:00:16', 0], ['06:30:16', 1]])
})

test('irrigation: the pump is stopped even when the program ends while it is running', async () => {
    const short = { ...repeated, totime: ms('06:00') + 5000 } // 5 s window, 15 s irrigation
    const { pin } = await runIrrigation(['06:00:00', '06:00:01', '06:00:06', '06:00:10', '06:00:16', '06:00:17'], { schedules: [short] })
    assert.deepEqual(pin, [['06:00:01', 1], ['06:00:16', 0]])
})

test('irrigation: an irrigation across midnight stops on time', async () => {
    const global = irrigationState({ irrisact: 1, irrtime: at('23:59:55', -1), irrprgact: { id: 1, fromtime: 0, totime: ms('23:59'), duration: 150, oneshoot: 0, every: 30 } })
    const { pin } = await runIrrigation(['00:00:05', '00:00:11'], { global, schedules: [] })
    assert.deepEqual(pin, [['00:00:11', 0]])
})

test('irrigation: a one shot program runs only once', async () => {
    const times = ['18:00:00', '18:00:01', '18:00:16']
    for (let s = 17; s < 60; s += 3) times.push(`18:00:${s}`)
    times.push('18:01:30', '18:02:00')
    const { pin } = await runIrrigation(times)
    assert.deepEqual(pin, [['18:00:01', 1], ['18:00:16', 0]])
})

test('irrigation: changing or deleting the running program stops the pump', async () => {
    const global = irrigationState({ irrisact: 1, irrtime: at('06:00:01'), irrprgact: { id: 0 } })
    const { pin } = await runIrrigation(['06:00:05'], { global, schedules: [] })
    assert.deepEqual(pin, [['06:00:05', 0]])
    assert.equal(global.get('irrigation.irrisact'), 0)
})

test('irrigation: manual irrigation has the priority', async () => {
    const { pin } = await runIrrigation(['06:00:00', '06:00:01'], { global: irrigationState({ manualirrigation: 1 }) })
    assert.deepEqual(pin, [])
})

test('irrigation: relay with inverted logic', async () => {
    const { pin } = await runIrrigation(['06:00:00', '06:00:01', '06:00:16'], { global: irrigationState({ output: { levelirr: 1 } }) })
    assert.deepEqual(pin, [['06:00:01', 0], ['06:00:16', 1]])
})

test('irrigation: inactive programs are ignored', async () => {
    const { pin } = await runIrrigation(['06:00:00', '06:00:01'], { schedules: [{ ...repeated, active: 0 }] })
    assert.deepEqual(pin, [])
})

// ---------------------------------------------------------------------------
// Climate
// ---------------------------------------------------------------------------
const program = { id: 1, active: 1, fromtime: ms('08:00'), totime: ms('20:00'), tempmin: 18, tempmax: 26, hummin: 40, hummax: 70 }

function climateState (extra = {}) {
    return createContext({
        climate: {
            inttemp: 22, inthum: 55, heatisact: 0, fanisact: 0, manualheat: 0, manualfan: 0, testmode: false,
            lastread: 'fresh', clmprgact: { id: 0 }, output: { levelheat: 0, levelfan: 0 },
            ...extra
        }
    })
}

/** run the scheduler twice (find program, then act) and return the final state and messages */
async function runClimate (state, { time = '12:00', schedules = [program] } = {}) {
    const flowCtx = createContext({ cache: { climate: schedules } })
    if (state.get('climate.lastread') === 'fresh') state.set('climate.lastread', at(time) - 60000) // read one minute ago
    const heat = []
    const fan = []
    const db = []
    for (let i = 0; i < 2; i++) {
        const { outputs } = await runFunction(climate, {}, { flow: flowCtx, global: state, now: at(time) })
        outputs[0].forEach(m => heat.push(m.payload))
        outputs[1].forEach(m => fan.push(m.payload))
        outputs[2].forEach(m => db.push(m.topic))
    }
    return { heat, fan, db, state }
}

const CASES = [
    // temperature, humidity, heating, fan
    [15, 30, true, false], [15, 55, true, false], [15, 80, true, true],
    [22, 30, true, false], [22, 55, false, false], [22, 80, false, true],
    [30, 30, false, true], [30, 55, false, true], [30, 80, false, true]
]
for (const [t, h, heatOn, fanOn] of CASES) {
    test(`climate: T ${t} °C RH ${h} % -> heating ${heatOn ? 'on' : 'off'}, fan ${fanOn ? 'on' : 'off'}`, async () => {
        const { state } = await runClimate(climateState({ inttemp: t, inthum: h }))
        assert.equal(state.get('climate.heatisact'), heatOn ? 1 : 0)
        assert.equal(state.get('climate.fanisact'), fanOn ? 1 : 0)
    })
}

test('climate: values equal to the limits are inside the range', async () => {
    const { state } = await runClimate(climateState({ inttemp: 18, inthum: 40, heatisact: 1 }))
    assert.equal(state.get('climate.heatisact'), 0, 'with T = Tmin and RH = RHmin nothing is needed')
})

test('climate: every change is written once in the actions log', async () => {
    const { heat, fan, db } = await runClimate(climateState({ inttemp: 15, inthum: 80 }))
    assert.deepEqual(heat, [1])
    assert.deepEqual(fan, [1])
    assert.equal(db.length, 2)
    assert.match(db[0], /"Heating start"\);$/)
    assert.match(db[1], /"Fan start"\);$/)
})

test('climate: relays with inverted logic', async () => {
    const { heat, fan } = await runClimate(climateState({ inttemp: 15, inthum: 80, output: { levelheat: 1, levelfan: 1 } }))
    assert.deepEqual(heat, [0])
    assert.deepEqual(fan, [0])
})

test('climate: outputs stop when the program is over', async () => {
    const { heat, db, state } = await runClimate(climateState({ heatisact: 1 }), { time: '21:00' })
    assert.deepEqual(heat, [0])
    assert.equal(state.get('climate.clmprgact.id'), 0)
    assert.match(db[0], /"Heating stop, no program"\);$/)
})

test('climate: outputs stop when the sensor is offline', async () => {
    const { heat, fan, db } = await runClimate(climateState({ heatisact: 1, fanisact: 1, lastread: at('12:00') - 6 * 60000 }))
    assert.deepEqual(heat, [0])
    assert.deepEqual(fan, [0])
    assert.match(db[0], /"Heating stop, sensor offline"\);$/)
})

test('climate: test mode ignores the sensor watchdog', async () => {
    const { state } = await runClimate(climateState({ inttemp: 15, lastread: 0, testmode: true }))
    assert.equal(state.get('climate.heatisact'), 1)
})

test('climate: manual commands have the priority', async () => {
    const { heat, fan } = await runClimate(climateState({ inttemp: 15, manualfan: 1 }))
    assert.deepEqual([heat, fan], [[], []])
})
