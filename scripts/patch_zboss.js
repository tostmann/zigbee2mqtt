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
        `CommandId[CommandId["SET_RX_ON_WHEN_IDLE"] = 19] = "SET_RX_ON_WHEN_IDLE";\n    CommandId[CommandId["GET_NETWORK_BACKUP"] = 153] = "GET_NETWORK_BACKUP";\n    CommandId[CommandId["RESTORE_NETWORK"] = 154] = "RESTORE_NETWORK";\n    CommandId[CommandId["GET_STRUCTURED_BACKUP"] = 155] = "GET_STRUCTURED_BACKUP";\n    CommandId[CommandId["RESTORE_STRUCTURED_BACKUP"] = 156] = "RESTORE_STRUCTURED_BACKUP";`,
    ],
]);

applyPatch("adapter/zboss/commands.js", [
    [
        `    [enums_2.CommandId.SET_RX_ON_WHEN_IDLE]: {\n        request: [{ name: "rxOn", type: enums_1.DataType.UINT8 }],\n        response: [...commonResponse],\n    },`,
        `    [enums_2.CommandId.SET_RX_ON_WHEN_IDLE]: {\n        request: [{ name: "rxOn", type: enums_1.DataType.UINT8 }],\n        response: [...commonResponse],\n    },\n    [enums_2.CommandId.GET_NETWORK_BACKUP]: {\n        request: [\n            { name: "offset", type: enums_1.DataType.UINT32 }\n        ],\n        response: [\n            ...commonResponse,\n            { name: "total_size", type: enums_1.DataType.UINT32 },\n            { name: "chunk_length", type: enums_1.DataType.UINT32 },\n            { \n                name: "data", \n                type: enums_1.BuffaloZclDataType.LIST_UINT8,\n                options: (payload, options) => {\n                    options.length = payload.chunk_length;\n                }\n            }\n        ],\n    },\n    [enums_2.CommandId.RESTORE_NETWORK]: {\n        request: [\n            { name: "offset", type: enums_1.DataType.UINT32 },\n            { name: "total_size", type: enums_1.DataType.UINT32 },\n            { name: "data", type: enums_1.BuffaloZclDataType.LIST_UINT8 }\n        ],\n        response: [...commonResponse],\n    },\n    [enums_2.CommandId.GET_STRUCTURED_BACKUP]: {\n        request: [],\n        response: [\n            ...commonResponse,\n            { name: "magic", type: enums_1.DataType.UINT32 },\n            { name: "format_version", type: enums_1.DataType.UINT8 },\n            { name: "flags", type: enums_1.DataType.UINT8 },\n            { name: "payload_len", type: enums_1.DataType.UINT16 },\n            { name: "tlvs", type: enums_1.BuffaloZclDataType.LIST_UINT8,\n                options: (payload, options) => { options.length = payload.payload_len; }\n            }\n        ],\n    },\n    [enums_2.CommandId.RESTORE_STRUCTURED_BACKUP]: {\n        request: [\n            { name: "magic", type: enums_1.DataType.UINT32 },\n            { name: "format_version", type: enums_1.DataType.UINT8 },\n            { name: "flags", type: enums_1.DataType.UINT8 },\n            { name: "payload_len", type: enums_1.DataType.UINT16 },\n            { name: "tlvs", type: enums_1.BuffaloZclDataType.LIST_UINT8 }\n        ],\n        response: [...commonResponse],\n    },`,
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

// ---------------------------------------------------------------------------
// Structured-backup upgrade (firmware v1.2.0+):
//
// The raw-NVS backup path above is opaque (a base64 blob of 40 KB) and tied
// to the exact firmware version + partition layout that produced it. The
// structured path uses two new NCP commands (GET_STRUCTURED_BACKUP 0x009B /
// RESTORE_STRUCTURED_BACKUP 0x009C) defined in tostmann/esp-coordinator's
// main/backup_structured.h, which carry the semantically meaningful fields
// (PAN, ExtPAN, channel, updateId, IEEE, NWK key, NWK outgoing frame
// counter, neighbor table) as a small TLV image (~80 B + 16 B/device).
//
// Strategy:
//   backup():  TRY structured first, fall back to raw-NVS on failure
//              (older firmware that doesn't know 0x009B returns NOT_IMPLEMENTED).
//   start():   If the JSON has a proper network_key + frame_counter, drive
//              RESTORE_STRUCTURED_BACKUP; else fall back to raw NVRAM restore
//              (preserves compatibility with backups taken on v1.1.x).
//
// JSON shape produced by the structured path is the standard Zigbee Alliance
// "Universal NWK Backup" format that zigbee2mqtt already understands — the
// raw_nvram blob in stack_specific.zboss is OMITTED so the backup is portable
// across firmware versions (and theoretically across adapter types).
// ---------------------------------------------------------------------------

// HYBRID backup: collect structured fields (for inspection / portability) AND
// raw_nvram (for byte-true restore). Per espressif/esp-zigbee-sdk#445 the
// public esp_zb_*_set_* APIs only take effect in factoryreset state, and even
// with the NIB-level esp_zb_nwk_set_extended_pan_id() the channel doesn't
// restore (chip ends on 0xFF). So restore stays on the raw_nvram path; the
// structured fields are decorative + Universal-NWK-Backup-format-compatible
// (so a future cross-adapter migration tool can read them).
applyPatch("adapter/zboss/adapter/zbossAdapter.js", [
    [
        // Anchor: the raw-NVS-only backup() body as left by the patch above.
        "    async backup(_ieeeAddressesInDatabase) {\n        return await this.queue.execute(async () => {\n            try {\n                let offset = 0;",
        `    async backup(_ieeeAddressesInDatabase) {\n        return await this.queue.execute(async () => {\n            // Hybrid backup: try the structured command first to populate the\n            // human-readable + portable fields (live NWK key, live frame counter,\n            // device list). Failure is non-fatal; raw_nvram below is the\n            // authoritative restore source.\n            let _structured = null;\n            try {\n                const res = await this.driver.execCommand(155 /* GET_STRUCTURED_BACKUP */, {});\n                if (res.payload.status === enums_1.StatusCodeGeneric.OK && res.payload.magic === 0x4253425A) {\n                    const tlvs = Buffer.from(res.payload.tlvs);\n                    const f = {};\n                    let p = 0;\n                    while (p + 3 <= tlvs.length) {\n                        const tag = tlvs[p]; const tlen = tlvs[p+1] | (tlvs[p+2] << 8); p += 3;\n                        const val = tlvs.slice(p, p + tlen); p += tlen;\n                        switch (tag) {\n                            case 0x01: f.pan_id = val.readUInt16LE(0); break;\n                            case 0x02: f.extended_pan_id = Buffer.from(val); break;\n                            case 0x03: f.channel = val[0]; break;\n                            case 0x04: f.network_update_id = val[0]; break;\n                            case 0x05: f.coordinator_ieee = Buffer.from(val); break;\n                            case 0x06: f.network_key = Buffer.from(val); break;\n                            case 0x08: f.frame_counter = val.readUInt32LE(0); break;\n                            case 0x10: {\n                                f.devices = [];\n                                for (let i = 0; i + 16 <= val.length; i += 16) {\n                                    f.devices.push({\n                                        networkAddress: val.readUInt16LE(i+8),\n                                        ieeeAddress: Buffer.from(val.slice(i, i+8)),\n                                        isDirectChild: true,\n                                    });\n                                }\n                                break;\n                            }\n                        }\n                    }\n                    _structured = f;\n                    logger_1.logger.info(\`Hybrid backup: structured pan=0x\${(f.pan_id||0).toString(16)} ch=\${f.channel} key=\${f.network_key?'yes':'no'} fc=\${f.frame_counter} devs=\${f.devices?f.devices.length:0}\`, NS);\n                }\n            } catch (e) {\n                logger_1.logger.info(\`Structured-backup capture failed (\${e.message}), continuing with raw-only\`, NS);\n            }\n            try {\n                let offset = 0;`,
    ],
]);

// Augment the returned backup object with structured fields if we collected
// any. The raw-NVS code above ended with:
//   const backup = { ... devices: [] };
//   return backup;
// We override the live-from-chip fields with our structured values where
// present (frame_counter is the most valuable — was hardcoded 0 in raw-only).
applyPatch("adapter/zboss/adapter/zbossAdapter.js", [
    [
        "                    securityLevel: 5,\n                    networkUpdateId: 0,\n                    devices: []\n                };\n                return backup;",
        "                    securityLevel: 5,\n                    networkUpdateId: 0,\n                    devices: []\n                };\n                if (_structured) {\n                    if (_structured.network_key) backup.networkOptions.networkKey = _structured.network_key;\n                    if (_structured.frame_counter != null) backup.networkKeyInfo.frameCounter = _structured.frame_counter;\n                    if (_structured.network_update_id != null) backup.networkUpdateId = _structured.network_update_id;\n                    if (_structured.devices) backup.devices = _structured.devices;\n                    if (_structured.coordinator_ieee) backup.coordinatorIeeeAddress = _structured.coordinator_ieee;\n                }\n                return backup;",
    ],
]);

// inReset frame-drop removal — formerly patched here — is UPSTREAM as of
// zigbee-herdsman 10.3.0 (PR Koenkk/zigbee-herdsman#1763). onPackage() no longer
// drops frames while `inReset` is set, so the NCP_RESET response / post-reboot
// boot-ready frame reach the undefined-tsn waitress matcher. The former uart.js
// onPackage patch entry was removed during the 10.1.0 -> 10.3.0 bump (it would
// only no-op against a stale anchor now).

// ---------------------------------------------------------------------------
// wifi-coex transport tolerance (tostmann/esp-coordinator wifi-coex variant):
// when the NCP runs over a raw TCP server on a single ESP32-C6 that time-shares
// one 2.4 GHz radio with the always-RX Zigbee coordinator, host<->NCP round-trips
// spike to several seconds (C1/"unstable" coex). herdsman's two fixed timeouts
// (link-layer ACK wait + command response wait) then abort z2m startup. Raise
// both. Harmless on the fast USB transport. Tunable; 30 s validated end-to-end.
// ---------------------------------------------------------------------------
applyPatch("adapter/zboss/uart.js", [
    ["waitFor(sequence, timeout = 2000)", "waitFor(sequence, timeout = 30000)"],
]);
applyPatch("adapter/zboss/driver.js", [
    ["execCommand(commandId, params = {}, timeout = 10000)", "execCommand(commandId, params = {}, timeout = 30000)"],
]);

// wifi-coex backup fallback: the raw 40 KB NVRAM pull (320 chunks even at the
// firmware's 1 KB chunk size) is unreliable over the coex/TCP link. The
// structured backup (GET_STRUCTURED_BACKUP, one small frame) succeeds reliably.
// If the raw pull throws, fall back to a structured-only Universal-NWK backup so
// z2m STARTS instead of crash-looping. Restore from such a backup is degraded
// (no raw_nvram -> may need re-pair) but the coordinator runs.
applyPatch("adapter/zboss/adapter/zbossAdapter.js", [
    [
        "            } catch (error) {\n                throw new Error(`Backup failed: ${error.message}`);\n            }",
        `            } catch (error) {\n                if (_structured && _structured.network_key) {\n                    logger_1.logger.info(\`Raw NVRAM backup failed over this link (\${error.message}); using structured-only backup (restore may need re-pair)\`, NS);\n                    const netInfo = this.driver.netInfo;\n                    return {\n                        coordinatorIeeeAddress: _structured.coordinator_ieee || Buffer.from(netInfo.ieeeAddr.replace("0x", ""), "hex").reverse(),\n                        networkOptions: {\n                            panId: netInfo.network.panID,\n                            extendedPanId: Buffer.from(netInfo.network.extendedPanID),\n                            channelList: [netInfo.network.channel],\n                            networkKey: _structured.network_key,\n                            networkKeyDistribute: false\n                        },\n                        logicalChannel: netInfo.network.channel,\n                        networkKeyInfo: { sequenceNumber: 0, frameCounter: _structured.frame_counter || 0 },\n                        securityLevel: 5,\n                        networkUpdateId: _structured.network_update_id || 0,\n                        devices: _structured.devices || []\n                    };\n                }\n                throw new Error(\`Backup failed: \${error.message}\`);\n            }`,
    ],
]);

// ---------------------------------------------------------------------------
// wifi-coex TCP recovery — backport of Koenkk/zigbee-herdsman#1779
// "fix(zboss): emit disconnected on unexpected port close" (not yet in a
// herdsman release; mapped onto the compiled 10.4.0 dist). When the NCP runs
// over a raw TCP server on a single ESP32-C6 (coex Mode B) and the socket
// drops (coex stall / peer reboot / keepalive/NAT timeout), the zboss adapter
// otherwise keeps running against a dead port and every command fails with
// "Connection not initialized" while z2m never notices. Chain after this fix:
// uart unexpected close -> emit "close" -> driver re-emit "close" ->
// adapter onDriverClose() (logs "Driver connection closed unexpectedly") ->
// emit "disconnected" -> herdsman Controller emits adapterDisconnected ->
// z2m Controller logs "Adapter disconnected, stopping" and stop(false, 2)
// (process exit 2) so the container restart policy recovers it, instead of a
// silent host-side wedge that needs a manual z2m restart.
// ---------------------------------------------------------------------------
applyPatch("adapter/zboss/uart.js", [
    [
`        if (this.inReset) {
            await (0, utils_1.wait)(3000);
            await this.openPort();
            this.inReset = false;
        }`,
`        if (this.inReset) {
            await (0, utils_1.wait)(3000);
            await this.openPort();
            this.inReset = false;
        }
        else if (!this.closing) {
            // Unexpected close (USB unplug, TCP peer reboot/keepalive drop, ...).
            // Notify upper layers so the application can handle the disconnect.
            // Without this the adapter keeps running against a dead port and
            // every subsequent command fails with "Connection not initialized".
            this.emit("close");
        }`,
    ],
]);
applyPatch("adapter/zboss/driver.js", [
    [
`        this.port.on("frame", this.onFrame.bind(this));`,
`        this.port.on("frame", this.onFrame.bind(this));
        this.port.on("close", () => this.emit("close"));`,
    ],
]);
applyPatch("adapter/zboss/adapter/zbossAdapter.js", [
    [
`        this.driver.on("frame", this.processMessage.bind(this));
    }
    async processMessage(frame) {`,
`        this.driver.on("frame", this.processMessage.bind(this));
        this.driver.on("close", this.onDriverClose.bind(this));
    }
    onDriverClose() {
        logger_1.logger.error("Driver connection closed unexpectedly", NS);
        this.emit("disconnected");
    }
    async processMessage(frame) {`,
    ],
]);

console.log("[ZBOSS Patch] Done.");
