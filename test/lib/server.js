'use strict'
// Start GreenMind in a temporary Node-RED user directory with a fake sensor board.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..', '..')
const USER = 'admin'
const PASSWORD = 'greenmind-ci-password'

function freePort () {
    return new Promise((resolve, reject) => {
        const srv = net.createServer()
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address()
            srv.close(() => resolve(port))
        })
        srv.on('error', reject)
    })
}

/** Fake ESPHome-like board: /sensor/temperatura and /sensor/bulbo_umido */
function startSensorBoard (values = { dry: 25, wet: 20 }) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const value = req.url.endsWith('/temperatura') ? values.dry : req.url.endsWith('/bulbo_umido') ? values.wet : null
            res.writeHead(value === null ? 404 : 200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ id: req.url, value, state: `${value} °C` }))
        })
        server.listen(0, '127.0.0.1', () => resolve({ server, values, host: `127.0.0.1:${server.address().port}` }))
    })
}

async function startGreenMind () {
    const board = await startSensorBoard()
    const port = await freePort()
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenmind-'))
    const workDir = path.join(userDir, 'home') // working directory: the database goes in home/greenmind/main.db
    fs.mkdirSync(path.join(userDir, 'greenmind'))
    fs.mkdirSync(path.join(workDir, 'greenmind'), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'greenmind.json'), path.join(userDir, 'greenmind', 'greenmind.json'))
    fs.copyFileSync(path.join(ROOT, 'installer', 'settings.js'), path.join(userDir, 'settings.js'))
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(userDir, 'node_modules'), 'dir')
    fs.writeFileSync(path.join(userDir, 'package.json'), fs.readFileSync(path.join(ROOT, 'package.json')))
    const bcrypt = require('bcryptjs')
    fs.writeFileSync(path.join(userDir, 'greenmind-auth.json'), JSON.stringify({
        username: USER, passwordHash: bcrypt.hashSync(PASSWORD, 8), credentialSecret: 'ci-secret'
    }))
    // point the flow to the fake sensor board (global context, file storage)
    fs.mkdirSync(path.join(userDir, 'context', 'global'), { recursive: true })
    fs.writeFileSync(path.join(userDir, 'context', 'global', 'global.json'),
        JSON.stringify({ climate: { config: { sensorhost: board.host, altitude: 0 } } }))

    const log = []
    const proc = spawn(process.execPath, [require.resolve('node-red/red.js'), '-u', userDir, '-p', String(port)], {
        cwd: workDir, env: { ...process.env, TZ: process.env.TZ || 'Europe/Rome' }
    })
    proc.stdout.on('data', d => log.push(...d.toString().split('\n').filter(Boolean)))
    proc.stderr.on('data', d => log.push(...d.toString().split('\n').filter(Boolean)))

    await waitFor(() => log.some(l => l.includes('Started flows')), 60000, () => log.join('\n'))
    const base = `http://127.0.0.1:${port}`
    return {
        base,
        port,
        userDir,
        workDir,
        board,
        log,
        credentials: { username: USER, password: PASSWORD },
        authHeader: 'Basic ' + Buffer.from(`${USER}:${PASSWORD}`).toString('base64'),
        async stop () {
            proc.kill('SIGINT')
            await new Promise(resolve => proc.once('exit', resolve))
            board.server.close()
            fs.rmSync(userDir, { recursive: true, force: true })
        }
    }
}

async function waitFor (check, timeout = 30000, describe = () => '') {
    const start = Date.now()
    while (Date.now() - start < timeout) {
        if (await check()) return
        await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error('timeout waiting for condition\n' + describe())
}

module.exports = { startGreenMind, waitFor }
