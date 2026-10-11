'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { loadFlow, findNode, createContext, runFunction } = require('../lib/flow')

const flow = loadFlow()
const calc = findNode(flow, { type: 'function', name: 'calculate RH, dew point, VPD' })
const saveDry = findNode(flow, { type: 'function', name: 'save dry bulb, set url' })
const skipTest = findNode(flow, { type: 'function', name: 'skip in test mode, set url' })

const reading = (dry, wet) => ({ statusCode: 200, drybulb: dry, payload: { value: wet } })

test('25 °C dry bulb and 20 °C wet bulb give 63 % RH, 17.5 °C dew point, 1.16 kPa VPD', async () => {
    const global = createContext({ climate: { config: { altitude: 0 } } })
    const { outputs } = await runFunction(calc, reading(25, 20), { global })
    assert.equal(global.get('climate.inttemp'), 25)
    assert.equal(global.get('climate.inthum'), 63)
    assert.equal(global.get('climate.dewpoint'), 17.5)
    assert.equal(global.get('climate.vpd'), 1.16)
    assert.ok(Date.now() - global.get('climate.lastread') < 5000)
    assert.deepEqual(outputs[0][0].payload, { inttemp: 25, inthum: 63, dewpoint: 17.5, vpd: 1.16 })
    assert.match(outputs[1][0].topic, /^INSERT INTO climate_detected\(.*VALUES \(NULL, \d+, 25, 63, NULL, NULL\);$/)
})

test('equal dry and wet bulb mean saturated air', async () => {
    const global = createContext()
    await runFunction(calc, reading(20, 20), { global })
    assert.equal(global.get('climate.inthum'), 100)
    assert.equal(global.get('climate.vpd'), 0)
    assert.equal(global.get('climate.dewpoint'), 20)
})

test('a wet bulb higher than the dry bulb is clamped to saturation', async () => {
    const global = createContext()
    await runFunction(calc, reading(18, 19), { global })
    assert.equal(global.get('climate.inthum'), 100)
})

test('very dry air never gives a negative humidity', async () => {
    const global = createContext()
    await runFunction(calc, reading(40, 10), { global })
    assert.equal(global.get('climate.inthum'), 0)
    assert.ok(global.get('climate.vpd') > 7)
})

test('altitude lowers the air pressure and raises the computed humidity', async () => {
    const sea = createContext({ climate: { config: { altitude: 0 } } })
    const mountain = createContext({ climate: { config: { altitude: 1500 } } })
    await runFunction(calc, reading(25, 20), { global: sea })
    await runFunction(calc, reading(25, 20), { global: mountain })
    assert.ok(mountain.get('climate.inthum') > sea.get('climate.inthum'))
})

test('a failed read does not update the values (watchdog keeps running)', async () => {
    const global = createContext({ climate: { lastread: 123 } })
    const { outputs } = await runFunction(calc, { statusCode: 500, drybulb: 25, payload: 'error' }, { global })
    assert.deepEqual(outputs, [[], []])
    assert.equal(global.get('climate.lastread'), 123)
    const dry = await runFunction(saveDry, { error: 'ENOTFOUND', payload: 'ENOTFOUND' })
    assert.deepEqual(dry.outputs, [[]])
})

test('sensor urls come from the configured host', async () => {
    const global = createContext({ climate: { config: { sensorhost: '10.0.0.5:8080' } } })
    const first = await runFunction(skipTest, {}, { global })
    assert.equal(first.outputs[0][0].url, 'http://10.0.0.5:8080/sensor/temperatura')
    const second = await runFunction(saveDry, { ...first.outputs[0][0], statusCode: 200, payload: { value: 21.3 } })
    assert.equal(second.outputs[0][0].url, 'http://10.0.0.5:8080/sensor/bulbo_umido')
    assert.equal(second.outputs[0][0].drybulb, 21.3)
})

test('sensors are not read in test mode', async () => {
    const global = createContext({ climate: { testmode: true } })
    const { outputs } = await runFunction(skipTest, {}, { global })
    assert.deepEqual(outputs, [[]])
})
