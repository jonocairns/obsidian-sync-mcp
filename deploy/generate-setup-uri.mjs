#!/usr/bin/env node
/**
 * Generate a LiveSync Setup URI for easy Obsidian configuration.
 *
 * Reads from environment variables:
 *   hostname, username, password, database, passphrase, uri_passphrase
 *
 * uri_passphrase is required: the caller generates it and shows it to the
 * user, so this script never prints a secret. Only the URI is written.
 */

import { encrypt } from "octagonal-wheels/encryption/encryption";

const uriPassphrase = process.env.uri_passphrase;
if (!uriPassphrase) {
    console.error("uri_passphrase is required");
    process.exit(1);
}

const conf = {
    couchDB_URI: process.env.hostname,
    couchDB_USER: process.env.username,
    couchDB_PASSWORD: process.env.password,
    couchDB_DBNAME: process.env.database || "obsidian",
    syncOnStart: true,
    gcDelay: 0,
    periodicReplication: true,
    syncOnFileOpen: true,
    encrypt: !!process.env.passphrase,
    passphrase: process.env.passphrase || "",
    usePathObfuscation: !!process.env.passphrase,
    batchSave: true,
    batch_size: 50,
    batches_limit: 50,
    useHistory: true,
    disableRequestURI: true,
    customChunkSize: 60,
    syncAfterMerge: false,
    concurrencyOfReadChunksOnline: 100,
    minimumIntervalOfReadChunksOnline: 100,
    handleFilenameCaseSensitive: false,
    doNotUseFixedRevisionForChunks: true,
    usePluginSyncV2: true,
    E2EEAlgorithm: "v2",
    settingVersion: 10,
    notifyThresholdOfRemoteStorageSize: 800,
};

const encryptedConf = encodeURIComponent(await encrypt(JSON.stringify(conf), uriPassphrase, false));
const setupURI = `obsidian://setuplivesync?settings=${encryptedConf}`;

console.log(setupURI);
