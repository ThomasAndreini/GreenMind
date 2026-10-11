GreenMind
==============

### About

GreenMind is a software designed for the management of a indoor crop. The intent is to allow complete control of a small greenhouse or an indoor crop that can be managed from a web interface accessible from both PC and smartphone.
Through GreenMind it is possible to manage irrigation, climate, artificial lighting, heating and ventilation of the environment. Each operation performed and data detected is recorded and shown as a graph and table.
GreenMind  is a ready-to-use product but it was created with the intention of being as open as possible, it is therefore developed through Node Red, a visual language that is very simple to learn and modify if the user wants to adapt it to specifics. needs.
The platform is the popular Raspberry pi, a low-cost board with great potential.
In order to run GreenMind a Raspberry pi 2 or higher is recommended, some hardware components such as relays and temperature and humidity sensors are required.
Support for other hardware components will be implemented over time, the goal is to use hardware components that are easy to find, at an affordable cost and of good quality. The user can choose which software modules and which hardware components to use according to their needs and budget.

<p align="center">
  <img src="docs/images/phone-home.png" alt="GreenMind on a smartphone" height="480">
  <img src="docs/images/phone-irrigation.png" alt="Irrigation page on a smartphone" height="480">
</p>
<p align="center">
  <img src="docs/images/desktop-home.png" alt="GreenMind on a desktop" width="720">
</p>

### What's new in v2

- **Responsive dashboard** built with [Dashboard 2.0](https://dashboard.flowfuse.com): one column on
  smartphones, two on tablets and desktops, three on wide screens. Tables become a stacked list on
  narrow screens, tap a row to edit it. It can be installed on the home screen as an app (PWA).
- **Home status tiles**: temperature, humidity, dew point, VPD, heating, fan and irrigation at a glance,
  with alarms for sensor offline and VPD out of range.
- **Psychrometer**: relative humidity, dew point and VPD (vapour pressure deficit) are computed from
  dry bulb and wet bulb temperatures, corrected for the altitude of the greenhouse.
- **Failsafe**: if the sensors do not answer for 5 minutes, heating and fan driven by the schedule are
  switched off and the event is logged.
- **Climate history** saved in the database for 30 days.
- **Security**: editor and dashboard are protected by user name and password.
- **Up to date runtime**: Node.js 22 LTS and Node-RED 5, Raspberry Pi 5 supported.

### Requirements

- Raspberry Pi 2 or newer (Pi 3, 4 or 5 recommended) with Raspberry Pi OS Bookworm or newer
- Relay board for irrigation pump, heating and fan
- A board that exposes the dry bulb and wet bulb temperatures over HTTP (see [Sensors](#sensors))

### Installation

Run on the Raspberry Pi:

```bash
curl -fsSL -o greenmind_installer https://raw.githubusercontent.com/ThomasAndreini/GreenMind/v2.0/installer/greenmind_installer
bash greenmind_installer
```

The installer installs Node.js 22 and Node-RED, copies GreenMind in `~/.node-red`, installs the
required nodes, asks for the user name and password used to protect the editor and the dashboard,
and starts Node-RED at boot.

Optional environment variables: `GM_REF` (branch or tag to install), `NODERED_VERSION`,
`GM_USER` and `GM_PASSWORD` (to install without prompts).

When it finishes open:

- Dashboard: `http://<raspberry-ip>:1880/dashboard`
- Node-RED editor: `http://<raspberry-ip>:1880`

### Wiring

Outputs use BCM numbering, the relay logic level when inactive can be set on the Settings section of
each page.

| Output          | BCM GPIO | Physical pin |
| --------------- | -------- | ------------ |
| Irrigation pump | 22       | 15           |
| Heating         | 17       | 11           |
| Fan             | 27       | 13           |

### Sensors

Every 60 seconds GreenMind reads two HTTP endpoints from the sensor board (host configurable in
*Climate > Settings*, default `climahub.local`):

- `http://<host>/sensor/temperatura` dry bulb temperature
- `http://<host>/sensor/bulbo_umido` wet bulb temperature

Both must answer with a JSON containing the value in °C, for example `{"value": 21.4}`
(the format used by ESPHome's web server).

### Upgrading from v1

- The flow is now in `~/.node-red/greenmind/greenmind.json`, the database stays in `~/greenmind/main.db`
  and schedules are kept.
- The dashboard moved from `/ui` to `/dashboard`.
- The legacy `node-red-dashboard`, `node-red-node-ui-table`, `node-red-contrib-ui-led` and
  `node-red-contrib-ui-timelines-chart` nodes are no longer used and can be removed from the palette.

### Development

The `Test` flow is disabled by default: enable it in the editor to simulate temperature and humidity
during the day (`climate.testmode`).
