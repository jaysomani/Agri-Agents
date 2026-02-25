const alawmulaw = require("alawmulaw");

function mulawToWav(mulawBuffer) {
    const mulawArray = new Uint8Array(mulawBuffer);
    const pcmSamples = alawmulaw.mulaw.decode(mulawArray);
    const numSamples = pcmSamples.length;
    const dataSize = numSamples * 2;
    const headerSize = 44;
    const fileSize = headerSize + dataSize;
    const buffer = Buffer.alloc(fileSize);
    let offset = 0;

    buffer.write("RIFF", offset);
    offset += 4;
    buffer.writeUInt32LE(fileSize - 8, offset);
    offset += 4;
    buffer.write("WAVE", offset);
    offset += 4;
    buffer.write("fmt ", offset);
    offset += 4;
    buffer.writeUInt32LE(16, offset);
    offset += 4;
    buffer.writeUInt16LE(1, offset);
    offset += 2;
    buffer.writeUInt16LE(1, offset);
    offset += 2;
    buffer.writeUInt32LE(8000, offset);
    offset += 4;
    buffer.writeUInt32LE(16000, offset);
    offset += 4;
    buffer.writeUInt16LE(2, offset);
    offset += 2;
    buffer.writeUInt16LE(16, offset);
    offset += 2;
    buffer.write("data", offset);
    offset += 4;
    buffer.writeUInt32LE(dataSize, offset);
    offset += 4;

    for (let i = 0; i < numSamples; i++) {
        buffer.writeInt16LE(pcmSamples[i], offset);
        offset += 2;
    }

    return buffer;
}

module.exports = {
    mulawToWav,
};
