const fs = require("node:fs");
const path = require("node:path");

const z2mPath = path.resolve(__dirname, "../node_modules/zigbee-herdsman/dist");

if (!fs.existsSync(z2mPath)) {
    console.log("[ZBOSS Patch] zigbee-herdsman not found. Skipping patch.");
    process.exit(0);
}

console.log("[ZBOSS Patch] Applying ESP32-C6 Backup & Restore enhancements...");

function applyPatch(file, replacers) {
    const fullPath = path.join(z2mPath, file);
    if (!fs.existsSync(fullPath)) return;
    let content = fs.readFileSync(fullPath, "utf8");
    let patched = false;
    for (const [search, replace] of replacers) {
        if (content.includes(search) && !content.includes(replace)) {
            content = content.replace(search, replace);
            patched = true;
        } else if (!content.includes(search) && !content.includes(replace)) {
            console.log(`[ZBOSS Patch] Warning: search pattern not found in ${file}`);
        }
    }
    if (patched) {
        fs.writeFileSync(fullPath, content, "utf8");
        console.log(`[ZBOSS Patch] Successfully patched: ${file}`);
    }
}

applyPatch("utils/backup.js", [
    [
        `...(backup.ezsp ? { ezsp: { hashed_tclk: backup.ezsp?.hashed_tclk?.toString("hex") || undefined } } : /* v8 ignore next */ undefined),\n        },`,
        `...(backup.ezsp ? { ezsp: { hashed_tclk: backup.ezsp?.hashed_tclk?.toString("hex") || undefined } } : /* v8 ignore next */ undefined),\n            ...(backup.zboss ? { zboss: { raw_nvram: backup.zboss?.raw_nvram } } : undefined),\n        },`,
    ],
    [
        "return {\n        networkOptions: {",
        "return {\n        ...(backup.stack_specific?.zboss ? { zboss: backup.stack_specific.zboss } : undefined),\n        networkOptions: {",
    ],
]);

applyPatch("adapter/zboss/enums.js", [
    [
        `CommandId[CommandId["SET_RX_ON_WHEN_IDLE"] = 19] = "SET_RX_ON_WHEN_IDLE";`,
        `CommandId[CommandId["SET_RX_ON_WHEN_IDLE"] = 19] = "SET_RX_ON_WHEN_IDLE";\n    CommandId[CommandId["GET_NETWORK_BACKUP"] = 153] = "GET_NETWORK_BACKUP";\n    CommandId[CommandId["RESTORE_NETWORK"] = 154] = "RESTORE_NETWORK";`,
    ],
]);

applyPatch("adapter/zboss/commands.js", [
    [
        `    [enums_2.CommandId.SET_RX_ON_WHEN_IDLE]: {\n        request: [{ name: "rxOn", type: enums_1.DataType.UINT8 }],\n        response: [...commonResponse],\n    },`,
        `    [enums_2.CommandId.SET_RX_ON_WHEN_IDLE]: {\n        request: [{ name: "rxOn", type: enums_1.DataType.UINT8 }],\n        response: [...commonResponse],\n    },\n    [enums_2.CommandId.GET_NETWORK_BACKUP]: {\n        request: [\n            { name: "offset", type: enums_1.DataType.UINT32 }\n        ],\n        response: [\n            ...commonResponse,\n            { name: "total_size", type: enums_1.DataType.UINT32 },\n            { name: "chunk_length", type: enums_1.DataType.UINT32 },\n            { \n                name: "data", \n                type: enums_1.BuffaloZclDataType.LIST_UINT8,\n                options: (payload, options) => {\n                    options.length = payload.chunk_length;\n                }\n            }\n        ],\n    },\n    [enums_2.CommandId.RESTORE_NETWORK]: {\n        request: [\n            { name: "offset", type: enums_1.DataType.UINT32 },\n            { name: "total_size", type: enums_1.DataType.UINT32 },\n            { name: "data", type: enums_1.BuffaloZclDataType.LIST_UINT8 }\n        ],\n        response: [...commonResponse],\n    },`,
    ],
]);

const zbossAdapterPatch = [
    [
        `    async supportsBackup() {\n        return await Promise.resolve(false);\n    }\n    async backup(_ieeeAddressesInDatabase) {\n        return await Promise.reject(new Error("This adapter does not support backup"));\n    }`,
        `    async supportsBackup() {\n        return await Promise.resolve(true);\n    }\n    async backup(_ieeeAddressesInDatabase) {\n        return await this.queue.execute(async () => {\n            try {\n                let offset = 0;\n                let total_size = 0;\n                let rawData = Buffer.alloc(0);\n                \n                do {\n                    const res = await this.driver.execCommand(enums_1.CommandId.GET_NETWORK_BACKUP, { offset: offset });\n                    if (res.payload.status !== enums_1.StatusCodeGeneric.OK) {\n                        throw new Error(\`Backup chunk failed at offset \${offset}\`);\n                    }\n                    total_size = res.payload.total_size;\n                    const chunk_length = res.payload.chunk_length;\n                    \n                    if (chunk_length > 0) {\n                        const chunkData = Buffer.from(res.payload.data.slice(0, chunk_length));\n                        rawData = Buffer.concat([rawData, chunkData]);\n                        offset += chunk_length;\n                    } else {\n                        break;\n                    }\n                } while (offset < total_size);\n                \n                const b64Data = rawData.toString('base64');\n                const netInfo = this.driver.netInfo;\n                \n                const backup = {\n                    zboss: {\n                        raw_nvram: b64Data\n                    },\n                    coordinatorIeeeAddress: Buffer.from(netInfo.ieeeAddr.replace("0x", ""), "hex").reverse(),\n                    networkOptions: {\n                        panId: netInfo.network.panID,\n                        extendedPanId: Buffer.from(netInfo.network.extendedPanID), \n                        channelList: [netInfo.network.channel],\n                        networkKey: Buffer.from(this.networkOptions.networkKey),\n                        networkKeyDistribute: false\n                    },\n                    logicalChannel: netInfo.network.channel,\n                    networkKeyInfo: {\n                        sequenceNumber: 0,\n                        frameCounter: 0\n                    },\n                    securityLevel: 5,\n                    networkUpdateId: 0,\n                    devices: []\n                };\n                return backup;\n            } catch (error) {\n                throw new Error(\`Backup failed: \${error.message}\`);\n            }\n        });\n    }`,
    ],
    [
        `            return {\n                type: "zboss",\n                meta: {\n                    coordinator: cver.payload.version,\n                    stack: ver2str(ver.payload.stackVersion),\n                    protocol: ver2str(ver.payload.protocolVersion),\n                    revision: ver2str(ver.payload.fwVersion),\n                },\n            };`,
        `            return {\n                type: "busware.de ESP32 (ZBOSS)",\n                meta: {\n                    coordinator: cver.payload.version,\n                    stack: ver2str(ver.payload.stackVersion),\n                    protocol: ver2str(ver.payload.protocolVersion),\n                    revision: ver2str(ver.payload.fwVersion),\n                },\n            };`,
    ],
    [
        `    async start() {\n        logger_1.logger.info("ZBOSS Adapter starting", NS);\n        await this.driver.connect();\n        return await this.driver.startup(this.adapterOptions.transmitPower);\n    }`,
        `    async start() {\n        logger_1.logger.info("ZBOSS Adapter starting", NS);\n        await this.driver.connect();\n        \n        try {\n            const fs = require('fs');\n            if (fs.existsSync(this.backupPath)) {\n                const backupJson = JSON.parse(fs.readFileSync(this.backupPath, 'utf8'));\n                if (backupJson.stack_specific && backupJson.stack_specific.zboss && backupJson.stack_specific.zboss.raw_nvram) {\n                    const rawNvramBase64 = backupJson.stack_specific.zboss.raw_nvram;\n                    if (rawNvramBase64.length > 1000) {\n                        if (await this.driver.needsToBeInitialised(this.networkOptions)) {\n                            logger_1.logger.info("Restoring ZBOSS NVRAM from backup...", NS);\n                            const rawData = Buffer.from(rawNvramBase64, 'base64');\n                            const total_size = rawData.length;\n                            let offset = 0;\n                            const chunkSize = 128;\n                            \n                            while (offset < total_size) {\n                                const end = Math.min(offset + chunkSize, total_size);\n                                const chunk = rawData.slice(offset, end);\n                                \n                                await this.driver.execCommand(154 /* RESTORE_NETWORK */, {\n                                    offset: offset,\n                                    total_size: total_size,\n                                    data: Array.from(chunk)\n                                });\n                                \n                                offset += chunk.length;\n                            }\n                            \n                            logger_1.logger.info("NVRAM Restore complete, ESP32 will reboot automatically. Waiting for reconnect...", NS);\n                            await new Promise(r => setTimeout(r, 2000));\n                            try {\n                                await this.driver.stop();\n                            } catch (e) { }\n                            await new Promise(r => setTimeout(r, 1000));\n                            await this.driver.connect();\n                            logger_1.logger.info("Resume Z2M startup after restore.", NS);\n                        }\n                    }\n                }\n            }\n        } catch (e) {\n            logger_1.logger.error(\`Failed to restore ZBOSS backup: \${e.message}\`, NS);\n        }\n\n        return await this.driver.startup(this.adapterOptions.transmitPower);\n    }`,
    ],
];

applyPatch("adapter/zboss/adapter/zbossAdapter.js", zbossAdapterPatch);

// Stop dropping inbound frames while ZBOSSDriver.reset() is awaiting the
// NCP_RESET response. Original behaviour (uart.js:onPackage):
//
//     async onPackage(data) {
//         if (this.inReset) return;
//         ...
//
// dropped EVERY frame received between `reset()` setting inReset=true and
// onPortClose clearing it. On ESP32-C6 USB-Serial-JTAG the device's USB CDC
// endpoint persists across `esp_restart()` (the ROM bootloader re-attaches
// the same descriptor essentially instantly), so the host doesn't reliably
// see a port-close to trigger onPortClose -> inReset never clears -> the
// device's tsn-matching NCP_RESET response AND the post-reboot boot-ready
// frame (commandId=2, tsn=0xFF sentinel) both get silently dropped. Result:
// reset() times out at 10 s, z2m exits with "Failed to start zigbee-herdsman"
// any time the user's configuration.yaml channel/panID doesn't match the
// device's persisted network (= the FactoryReset path).
//
// Even the firmware-side USB phy detach in tostmann/esp-coordinator (clears
// DP_PULLUP + USB_PAD_ENABLE for 800 ms in the NCP_RESET deferred task)
// doesn't fully close the loop: the tsn-matching response was already dropped
// before the detach, and the post-reboot boot-ready frame arrives inside the
// ~3 s reopen wait inside onPortClose while the host port is closed. The
// proper fix is here, in the host parser.
//
// The CRC8/CRC16 checks further down in onPackage already reject any garbage
// that arrives during the reset window (ROM banner ASCII, partial frames,
// electrical noise), so removing the drop is safe. driver.js execCommand
// already uses `tsn: undefined` wildcard for NCP_RESET (see ~line 235), so
// either the original response or the boot-ready frame satisfies the pending
// waiter as soon as it reaches onFrame.
//
// Verified live 2026-05-20: factory-reset path now passes through
// "Driver reset -> Form network" without the prior 10 s timeout.
applyPatch("adapter/zboss/uart.js", [
    [
        "    async onPackage(data) {\n        if (this.inReset)\n            return;\n        const len = data.readUInt16LE(0);",
        "    async onPackage(data) {\n        // PATCHED: do NOT drop frames during inReset. See scripts/patch_zboss.js\n        // for rationale (ESP32-C6 USB-Serial-JTAG persists across esp_restart so\n        // onPortClose may never fire to clear inReset; CRC checks below reject\n        // any garbage that arrives during the reset window).\n        const len = data.readUInt16LE(0);",
    ],
]);

console.log("[ZBOSS Patch] Done.");
