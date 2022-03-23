#!/bin/bash
#
#!/bin/bash
#
# This script include node-red script installer for deb systems
# Make a backup of /home/pi/grower-assistant folder if you make an update

# Grower Assistant Installer for Raspberry pi OS lite

if bash <(curl -sL https://raw.githubusercontent.com/node-red/linux-installers/master/deb/update-nodejs-and-nodered) --confirm-install --confirm-pi --nodered-version="2.2.2" --node14 ; then
    echo "Node Red installed, now create a grower-assistant folder"
else
    echo "Node Red installation failed, check node red log for more details"
	exit 1
fi
if mkdir -p /home/pi/grower-assistant/ ; then
	echo "Directory create, download Grower Assistant files"
else
	echo "Failed to create download, check permission or reboot, exit"
	exit 1
fi
cd /home/pi/grower-assistant/
if wget https://github.com/ThomasAndreini/GrowerAssistant/blob/master/growerassistant.json ; then
	echo "growerassistant.json downloaded, download modified settings.js"
else
	echo "cannot download growerassistant.json, check your internet connection, exit"
	exit 1
fi
cd /home/pi/.node-red
if wget https://github.com/ThomasAndreini/GrowerAssistant/blob/master/installer/settings.js ; then
	echo "settings.js downloaded, download DHT22 libraries"
else
	echo "cannot download settings.js, check your internet connection, exit"
	exit 1
fi
if npm install --unsafe-perm -g node-dht-sensor ; then
	echo "dht library installed, download package.json"
else
	echo "dht library not installed, check your internet connection, exit"
	exit 1
fi
if wget https://github.com/ThomasAndreini/GrowerAssistant/blob/master/package.json ; then
	echo "package.json downloaded, install it"
else
	echo "cannot download package.json, check your internet connection, exit"
	exit 1
fi
if npm install ; then
	echo "extra nodes installed, Grower Assistant is installed succesfully, start node red"
else
	echo "can't install extra nodes, exit"
	exit 1
fi
node-red-start