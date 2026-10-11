'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const { startGreenMind, waitFor } = require('../lib/server')

const DEVICES = {
    phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    tablet: { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true },
    desktop: { viewport: { width: 1440, height: 900 } }
}
// log lines that are expected on a machine that is not a Raspberry Pi
const EXPECTED_LOG = [/rpi-gpio/i, /Raspberry Pi specific/i, /Encrypted credentials not found/]

let gm
let browser

test.before(async () => {
    gm = await startGreenMind()
    // CHROMIUM_PATH: use an already installed Chromium instead of the one downloaded by Playwright
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
})

test.after(async () => {
    await browser?.close()
    await gm?.stop()
})

async function openPage (device, path) {
    const context = await browser.newContext({ ...DEVICES[device], httpCredentials: gm.credentials })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(`${gm.base}/dashboard/${path}`, { waitUntil: 'networkidle' })
    await page.locator('.nrdb-ui-group').first().waitFor()
    return { page, context, errors }
}

test('Node-RED starts the flow without errors', async () => {
    // wait for the first sensor reading and the scheduler loops
    await waitFor(() => gm.log.some(l => l.includes('Started flows')))
    await new Promise(resolve => setTimeout(resolve, 8000))
    const errors = gm.log.filter(l => /\[(error|warn)\]/.test(l))
        .filter(l => !EXPECTED_LOG.some(re => re.test(l)))
        .filter(l => !/Projects disabled|\[warn\] *$|-{10,}/.test(l))
    assert.deepEqual(errors, [])
})

test('dashboard and editor require the password', async () => {
    const plain = await fetch(`${gm.base}/dashboard/home`)
    assert.equal(plain.status, 401)
    const wrong = await fetch(`${gm.base}/dashboard/home`, { headers: { Authorization: 'Basic ' + Buffer.from('admin:wrong').toString('base64') } })
    assert.equal(wrong.status, 401)
    const ok = await fetch(`${gm.base}/dashboard/home`, { headers: { Authorization: gm.authHeader } })
    assert.equal(ok.status, 200)
    const flows = await fetch(`${gm.base}/flows`)
    assert.equal(flows.status, 401)
    const login = await fetch(`${gm.base}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: 'node-red-admin', grant_type: 'password', scope: '*', username: gm.credentials.username, password: gm.credentials.password })
    })
    assert.equal(login.status, 200)
})

test('dashboard socket refuses connections without the password', async () => {
    async function connect (headers) {
        const url = `${gm.base}/dashboard/socket.io/?EIO=4&transport=polling`
        const handshake = await (await fetch(url, { headers })).text()
        const sid = JSON.parse(handshake.slice(1)).sid
        await fetch(`${url}&sid=${sid}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '40' })
        return (await fetch(`${url}&sid=${sid}`, { headers })).text()
    }
    assert.match(await connect({}), /^44.*Unauthorized/)
    assert.match(await connect({ Authorization: gm.authHeader }), /^40/)
})

test('pages fit every screen without horizontal scroll', async () => {
    for (const device of Object.keys(DEVICES)) {
        for (const path of ['home', 'irrigation', 'climate']) {
            const { page, context, errors } = await openPage(device, path)
            await page.waitForTimeout(1000)
            const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])
            assert.ok(scrollWidth <= innerWidth, `${device} ${path}: scrollWidth ${scrollWidth} > ${innerWidth}`)
            assert.deepEqual(errors, [], `${device} ${path} page errors`)
            await context.close()
        }
    }
})

test('home shows the values computed from the sensors', async () => {
    const { page, context } = await openPage('phone', 'home')
    await waitFor(async () => (await page.locator('.gm-tiles').innerText()).includes('63 %'), 30000)
    const tiles = (await page.locator('.gm-tiles').innerText()).replace(/\s+/g, ' ')
    assert.match(tiles, /Temperature 25\.0 °C/)
    assert.match(tiles, /Dew point 17\.5 °C/)
    assert.match(tiles, /VPD 1\.16 kPa/)
    await context.close()
})

test('irrigation schedules can be added, edited and deleted from a phone', async () => {
    const { page, context } = await openPage('phone', 'irrigation')
    const schedule = page.locator('.nrdb-ui-group').filter({ hasText: 'Tap a row' })
    const rows = () => schedule.locator('tbody tr')

    // add 12:30-13:00 every 20 min, 100 ml
    const times = schedule.locator('input[type=time]')
    await times.nth(0).fill('12:30')
    await times.nth(0).blur()
    await times.nth(1).fill('13:00')
    await times.nth(1).blur()
    const every = schedule.getByLabel('Every (min)')
    const duration = schedule.getByLabel('Duration (ml)')
    await every.fill('20')
    await every.blur()
    await duration.fill('100')
    await duration.blur()
    await page.waitForTimeout(500)
    await schedule.getByRole('button', { name: 'Add' }).click()
    await waitFor(async () => (await rows().allInnerTexts()).join(' ').includes('12:30'))
    const added = (await rows().allInnerTexts()).join(' ').replace(/\s+/g, ' ')
    assert.match(added, /12:30 To 13:00 Every \(min\) 20 Duration \(ml\) 100/)

    // tap the row, the form is filled with its values
    await rows().filter({ hasText: '12:30' }).first().click()
    await page.waitForTimeout(500)
    assert.equal(await times.nth(0).inputValue(), '12:30')
    assert.equal(await times.nth(1).inputValue(), '13:00')
    assert.equal(await every.inputValue(), '20')

    // edit every to 45 min
    await every.fill('45')
    await every.blur()
    await page.waitForTimeout(500)
    await schedule.getByRole('button', { name: 'Edit' }).click()
    await waitFor(async () => (await rows().allInnerTexts()).join(' ').replace(/\s+/g, ' ').includes('Every (min) 45'))

    // delete it
    await schedule.getByRole('button', { name: 'Delete' }).click()
    await waitFor(async () => !(await rows().allInnerTexts()).join(' ').includes('12:30'))
    await context.close()
})

test('an overlapping schedule is refused with a notification', async () => {
    const { page, context } = await openPage('desktop', 'climate')
    const schedule = page.locator('.nrdb-ui-group').filter({ hasText: 'Tap a row' })
    const times = schedule.locator('input[type=time]')
    for (const [from, to] of [['08:00', '20:00'], ['10:00', '11:00']]) {
        await times.nth(0).fill(from)
        await times.nth(0).blur()
        await times.nth(1).fill(to)
        await times.nth(1).blur()
        await page.waitForTimeout(500)
        await schedule.getByRole('button', { name: 'New' }).click()
        await page.waitForTimeout(1000)
    }
    await page.getByText(/overlapping schedule id/).waitFor({ timeout: 10000 })
    await context.close()
})

test('heating and fan follow the climate schedule', async () => {
    // the schedule 08:00-20:00 is active only during the day, use one that covers the whole day
    const { page, context } = await openPage('desktop', 'climate')
    const schedule = page.locator('.nrdb-ui-group').filter({ hasText: 'Tap a row' })
    await schedule.locator('tbody tr').first().click()
    await page.waitForTimeout(500)
    const times = schedule.locator('input[type=time]')
    await times.nth(0).fill('00:00')
    await times.nth(0).blur()
    await times.nth(1).fill('23:59')
    await times.nth(1).blur()
    // 25 °C is below the minimum: heating on
    const values = { 'T min (°C)': '26', 'T max (°C)': '30', 'RH min (%)': '40', 'RH max (%)': '70' }
    for (const [label, value] of Object.entries(values)) {
        await schedule.getByLabel(label).fill(value)
        await schedule.getByLabel(label).blur()
    }
    await schedule.locator('.v-switch input').first().check()
    await page.waitForTimeout(500)
    await schedule.getByRole('button', { name: 'Edit' }).click()
    await page.waitForTimeout(1000)
    await context.close()

    const home = await openPage('desktop', 'home')
    const tile = (label) => home.page.locator('.gm-tile', { hasText: label }).locator('.gm-tile-value')
    await waitFor(async () => (await tile('Heating').innerText()) === 'ON', 20000)
    assert.equal(await tile('Fan').innerText(), 'OFF')

    await home.context.close()
})
