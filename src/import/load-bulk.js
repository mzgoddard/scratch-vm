const Asset = require('scratch-storage/src/Asset');

class Bulk {
    constructor () {
        this.table = {};
        this.slices = [];
    }

    static fromSliceAssets (sliceAssets) {
        const bulk = new Bulk();
        bulk.slices = sliceAssets.map(BulkSlice.fromAsset);
    }

    static createAssets (bulk) {
        const assets = this.slices.map(BulkSlice.createAsset);
        return {
            assetIds: assets.map(asset => asset.assetId),
            assets,
        };
    }

    add (asset, offset = 0) {
        if (this.slices.length === 0) {
            this.slices.unshift(new BulkSlice());
        }

        this.table[asset.assetId] = this.table[asset.assetId] || {
            assetId: asset.assetId,
            dataFormat: asset.dataFormat,
            dataSize: asset.data.length,
            slices: []
        };
        this.table[asset.assetId].slices.push(this.slices.length);

        const written = this.slices[0].add(asset, offset);

        if (offset + written < asset.data.length) {
            this.slices.unshift(new BulkSlice());
            this.add(asset, offset + written);
        }
    }

    find (assetId) {
        const pieces = [];
        for (let i = 0; i < this.slices.length; i++) {
            const piece = this.slices[i].find(assetId);
            if (piece) {
                pieces.unshift(piece, this.slices[i]);
            } else if (pieces.length > 0) {
                break;
            }
        }

        if (pieces.length) {
            const data = new Uint8Array(pieces[0].dataSize);
            for (let i = 0; i < pieces.length; i += 2) {
                const piece = pieces[i + 0];
                const slice = pieces[i + 1];

                data.set(new Uint8Buffer(slice.buffer, piece.bulkOffset, piece.bulkEnd), piece.dataOffset);
            }
            return {
                assetId,
                dataFormat: pieces[0].dataFormat,
                data
            };
        }
        return null;
    }
}

const MAX_BUFFER_SIZE = 2 * 1024 * 1024;
const TAIL_INDEX_SIZE = 4;

class BulkSlice {
    constructor () {
        this.table = {};
        this.buffer = new ArrayBuffer(MAX_BUFFER_SIZE);
        this.bytes = new Uint8Array(this.buffer);
        this.writeIndex = 0;
        this.tailSize = 0;
        this.maxBodySize = MAX_BUFFER_SIZE - this.tailSize - TAIL_INDEX_SIZE;
    }

    static fromAsset (asset) {
        const slice = new BulkSlice();

        const data = asset.data.buffer ? asset.data : new Uint8Array(asset.data);
        const writeIndex = new Uint32Array(data, data.length - 4)[0];
        const decodedTail = new TextDecoder().decode(new Uint8Array(data.buffer, writeIndex, data.length - 4));

        slice.bytes.set(new Uint8Array(data.buffer, 0, writeIndex));
        slice.table = JSON.parse(decodedTail);
        slice.writeIndex = writeIndex;
    }

    static createAsset (slice) {
        const encodedTail = new TextEncoder().encode(JSON.stringify(slice.table));

        const data = new Uint8Array(slice.writeIndex + slice.tailSize + TAIL_INDEX_SIZE);
        data.set(new Uint8Array(slice.buffer, 0, slice.writeIndex));
        data.set(encodedTail, slice.writeIndex);
        data.set(new Uint32Array([slice.writeIndex]), slice.writeIndex + slice.tailSize);

        const asset = new Asset({}, null, {}, data, true);
        return {
            assetId: asset.assetId,
            dataFormat: asset.dataFormat,
            data: asset.data
        };
    }

    add (asset, offset = 0) {
        if (this.writeIndex === this.maxBodySize) return 0;

        const data = asset.data.buffer ? asset.data : new Uint8Array(asset.data);

        const tableAssets = Object.values(this.table);
        const lastAsset = tableAssets[tableAssets.length - 1];
        if (lastAsset) {
            lastAsset.bulkEnd = this.writeIndex;
        }

        this.table[asset.assetId] = {
            assetId: assetId,
            dataFormat: dataFormat,
            dataOffset: offset,
            dataSize: data.length,
            bulkOffset: this.writeIndex,
            bulkEnd: -1
        };
        this.tailSize = new TextEncoder().encode(JSON.stringify(this.table)).byteLength;
        this.maxBodySize = MAX_BUFFER_SIZE - this.tailSize - TAIL_INDEX_SIZE;

        const written = Math.min(asset.data.length - offset, this.maxBodySize - this.writeIndex);
        this.bytes.set(new Uint8Array(data.buffer, offset, offset + written), this.writeIndex);
        this.writeIndex += written;
        return written;
    }

    find (assetId) {
        if (this.table[assetId]) {
            if (this.table[assetId].dataEnd === -1) {
                return Object.assign({}, this.table[assetId], {
                    bulkEnd: this.writeIndex
                });
            }
            return this.table[assetId];
        }
        return null;
    }
}

class BulkItem {
    constructor () {

    }
}
