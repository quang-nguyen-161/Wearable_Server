// TB CoAP Integration - Uplink Data Converter
// TB Cloud -> Integrations -> CoAP integration -> Edit -> Uplink data converter
// Paste only from "var arr" onwards into the TB editor.
//
// In this TB Cloud version, payload is a raw byte array (decimal ASCII codes).
// We convert bytes -> string -> JSON.parse to access the fields.

var arr = [];
for (var i = 0; i < payload.length; i++) {
    arr.push(payload[i] & 0xff);
}
var data = JSON.parse(String.fromCharCode.apply(null, arr));

return {
    deviceName: data.deviceName,
    deviceType: 'default',
    telemetry: [{
        ts: data.ts || Date.now(),
        values: {
            ecg_batch: data.ecg_batch,
            ppg_batch: data.ppg_batch
        }
    }]
};
