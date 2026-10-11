'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { loadFlow, findNode, createContext, runFunction, ms } = require('../lib/flow')

const flow = loadFlow()
const overview = findNode(flow, { type: 'function', name: 'format schedule overview' })
const status = findNode(flow, { type: 'function', name: 'build status' })

test('schedule overview places the schedules on a 24h timeline', async () => {
    const flowCtx = createContext({
        timechart: {
            irrigationschedule: [
                { fromtime: ms('06:00'), totime: ms('12:00'), every: 30, duration: 150, oneshoot: 0 },
                { fromtime: ms('18:00'), totime: ms('18:00') + 20000, every: 0, duration: 200, oneshoot: 1 }
            ],
            climateschedule: [{ fromtime: ms('08:00'), totime: ms('20:00'), tempmin: 18, tempmax: 26, hummin: 40, hummax: 70 }]
        }
    })
    const { outputs } = await runFunction(overview, {}, { flow: flowCtx })
    const [irrigation, climate] = outputs[0][0].payload.lanes
    assert.equal(irrigation.items.length, 2)
    assert.deepEqual(irrigation.items[0], { from: '06:00', to: '12:00', left: 25, width: 25, label: 'Every 30 min, 150 ml' })
    assert.equal(irrigation.items[1].label, 'One shot, 200 ml')
    assert.ok(irrigation.items[1].width >= 0.5, 'very short schedules stay visible')
    assert.equal(climate.items[0].label, 'T 18-26 °C, RH 40-70 %')
})

test('schedule overview works with no schedules', async () => {
    const { outputs } = await runFunction(overview, {}, { flow: createContext() })
    assert.deepEqual(outputs[0][0].payload.lanes.map(l => l.items.length), [0, 0])
})

test('status tiles report values, outputs and alarms', async () => {
    const global = createContext({
        climate: { inttemp: 24.5, inthum: 55, dewpoint: 14.9, vpd: 1.8, lastread: Date.now(), heatisact: 0, fanisact: 1 },
        irrigation: { irrisact: 1 }
    })
    const { outputs } = await runFunction(status, {}, { global })
    assert.deepEqual(outputs[0][0].payload, {
        inttemp: 24.5, inthum: 55, dewpoint: 14.9, vpd: 1.8, vpdState: 'high', sensorOk: true, heat: false, fan: true, irrigation: true
    })
})

test('status reports the sensor offline after 5 minutes without data', async () => {
    const global = createContext({ climate: { lastread: Date.now() - 6 * 60000 } })
    const { outputs } = await runFunction(status, {}, { global })
    assert.equal(outputs[0][0].payload.sensorOk, false)
})
