'use strict'
// Tests of the installer functions and of the backup / restore used to migrate to the 64 bit OS.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..', '..')
const INSTALLER = path.join(ROOT, 'installer', 'greenmind_installer')
const BACKUP = path.join(ROOT, 'installer', 'greenmind_backup')

function tmp () {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gm-installer-'))
}

/** directory with fake commands (dpkg, sudo, systemctl) put first in PATH */
function fakeBin (commands) {
    const dir = tmp()
    for (const [name, script] of Object.entries(commands)) {
        fs.writeFileSync(path.join(dir, name), `#!/bin/bash\n${script}\n`, { mode: 0o755 })
    }
    return dir
}

/** run a bash snippet with the installer functions loaded */
function withInstaller (snippet, { env = {}, bin } = {}) {
    const result = spawnSync('bash', ['-c', `source "${INSTALLER}"\n${snippet}`], {
        encoding: 'utf8',
        env: {
            ...process.env,
            GM_INSTALLER_SOURCE_ONLY: '1',
            ...(bin ? { PATH: `${bin}:${process.env.PATH}` } : {}),
            ...env
        }
    })
    return { code: result.status, out: result.stdout, err: result.stderr }
}

function meminfo (ramMb, swapMb) {
    const file = path.join(tmp(), 'meminfo')
    fs.writeFileSync(file, `MemTotal:       ${ramMb * 1024} kB\nMemFree:         100000 kB\nSwapTotal:      ${swapMb * 1024} kB\n`)
    return file
}

test('Node.js heap is sized on the RAM of the board', () => {
    const boards = [
        [416, 256], // Zero 2 W, 512 MB
        [906, 256], // Pi 3, 1 GB
        [1906, 448], // Pi 4, 2 GB
        [3884, 960], // Pi 4 / Pi 5, 4 GB
        [7810, 1024], // Pi 4 / Pi 5, 8 GB
        [16000, 1024] // Pi 5, 16 GB
    ]
    for (const [ram, heap] of boards) {
        const { out } = withInstaller(`heap_size_mb ${ram}`)
        assert.equal(out.trim(), String(heap), `${ram} MB RAM`)
    }
})

test('memory check reads /proc/meminfo and refuses boards with too little RAM', () => {
    const ok = withInstaller('check_memory; echo "heap=${GM_HEAP_MB}"', { env: { MEMINFO: meminfo(3884, 512) } })
    assert.equal(ok.code, 0)
    assert.match(ok.out, /Memory: 3884 MB RAM, 512 MB swap, Node.js heap 960 MB/)
    assert.match(ok.out, /heap=960/)

    const forced = withInstaller('check_memory; echo "heap=${GM_HEAP_MB}"', { env: { MEMINFO: meminfo(3884, 512), GM_HEAP_MB: '700' } })
    assert.match(forced.out, /heap=700/)

    const small = withInstaller('check_memory', { env: { MEMINFO: meminfo(240, 0) } })
    assert.notEqual(small.code, 0)
    assert.match(small.err, /at least 512 MB/)
})

test('low RAM boards without swap get a warning', () => {
    const { code, out } = withInstaller('check_memory', { env: { MEMINFO: meminfo(416, 100) } })
    assert.equal(code, 0)
    assert.match(out, /swap/)
})

test('the heap size is written in a systemd drop-in', () => {
    const dir = path.join(tmp(), 'nodered.service.d')
    const bin = fakeBin({ sudo: '"$@"', systemctl: 'exit 0' })
    const { code } = withInstaller('GM_HEAP_MB=448; configure_memory', { bin, env: { SYSTEMD_DROPIN_DIR: dir } })
    assert.equal(code, 0)
    assert.match(fs.readFileSync(path.join(dir, 'greenmind.conf'), 'utf8'),
        /^\[Service\]\n.*\nEnvironment="NODE_OPTIONS=--max-old-space-size=448"\n$/)
})

test('only the 64 bit OS is accepted', () => {
    for (const [arch, ok] of [['arm64', true], ['amd64', true], ['armhf', false], ['armel', false]]) {
        const bin = fakeBin({ dpkg: `echo ${arch}` })
        const { code, err } = withInstaller('check_platform', { bin })
        assert.equal(code === 0, ok, `${arch}: ${err}`)
        if (!ok) assert.match(err, /requires Raspberry Pi OS 64 bit[\s\S]*greenmind_backup[\s\S]*GM_RESTORE/)
    }
    const bin = fakeBin({ dpkg: 'echo arm64' })
    assert.notEqual(withInstaller('check_platform', { bin, env: { NODE_MAJOR: '18' } }).code, 0)
})

function oldInstallation () {
    const home = tmp()
    fs.mkdirSync(path.join(home, 'greenmind'))
    fs.writeFileSync(path.join(home, 'greenmind', 'main.db'), 'sqlite data')
    fs.mkdirSync(path.join(home, '.node-red', 'context', 'global'), { recursive: true })
    fs.writeFileSync(path.join(home, '.node-red', 'context', 'global', 'global.json'), '{"irrigation":{"config":{"flowrate":36}}}')
    fs.writeFileSync(path.join(home, '.node-red', 'greenmind-auth.json'), '{"username":"admin"}')
    fs.writeFileSync(path.join(home, '.node-red', 'settings.js'), 'old settings, not in the backup')
    return home
}

test('backup on the old system and restore on the new one', () => {
    const oldHome = oldInstallation()
    const archive = path.join(tmp(), 'backup.tar.gz')
    const bin = fakeBin({ systemctl: 'exit 3', sudo: '"$@"' }) // Node-RED not running
    const backup = spawnSync('bash', [BACKUP, archive], { encoding: 'utf8', env: { ...process.env, HOME: oldHome, PATH: `${bin}:${process.env.PATH}` } })
    assert.equal(backup.status, 0, backup.stderr)
    assert.equal(fs.statSync(archive).mode & 0o777, 0o600, 'the backup contains the password hash')

    const newHome = tmp()
    fs.mkdirSync(path.join(newHome, '.node-red'))
    const restore = withInstaller(`restore_backup "${archive}"`, { env: { HOME: newHome, NODERED_DIR: path.join(newHome, '.node-red') } })
    assert.equal(restore.code, 0, restore.err)
    assert.equal(fs.readFileSync(path.join(newHome, 'greenmind', 'main.db'), 'utf8'), 'sqlite data')
    assert.match(fs.readFileSync(path.join(newHome, '.node-red', 'context', 'global', 'global.json'), 'utf8'), /flowrate/)
    assert.equal(fs.statSync(path.join(newHome, '.node-red', 'greenmind-auth.json')).mode & 0o777, 0o600)
    assert.ok(!fs.existsSync(path.join(newHome, '.node-red', 'settings.js')))
})

test('restore refuses archives with unexpected files', () => {
    for (const evil of ['../evil', '.bashrc', '.node-red/settings.js']) {
        const src = tmp()
        const file = path.join(src, evil)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, 'x')
        const archive = path.join(tmp(), 'evil.tar.gz')
        // -P keeps "../" in the member name
        spawnSync('tar', ['-czPf', archive, '-C', src, evil])
        const home = tmp()
        const { code, err } = withInstaller(`restore_backup "${archive}"`, { env: { HOME: home } })
        assert.notEqual(code, 0, evil)
        assert.match(err, /Unexpected (path|file) in backup/)
        assert.deepEqual(fs.readdirSync(home), [], `${evil} must not be extracted`)
    }
})

test('restore refuses archives with links', () => {
    const src = tmp()
    fs.mkdirSync(path.join(src, '.node-red', 'context'), { recursive: true })
    fs.symlinkSync('/etc', path.join(src, '.node-red', 'context', 'global'))
    const archive = path.join(tmp(), 'link.tar.gz')
    spawnSync('tar', ['-czf', archive, '-C', src, '.node-red/context'])
    const home = tmp()
    const { code, err } = withInstaller(`restore_backup "${archive}"`, { env: { HOME: home } })
    assert.notEqual(code, 0)
    assert.match(err, /Unexpected link in backup/)
    assert.deepEqual(fs.readdirSync(home), [])
})
