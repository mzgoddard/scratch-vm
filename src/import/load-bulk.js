const Asset = require('scratch-storage/src/Asset');

const isPromise = obj => typeof obj.then === 'function';

class Bulk {
    constructor () {
        // this.table = {};
        this.slices = [];
    }

    static fromSliceAssets (sliceAssets) {
        const bulk = new Bulk();
        bulk.slices = sliceAssets.slice();
        for (let i = 0; i < bulk.slices.length; i++) {
            bulk.slices[i] = BulkSlice.fromAsset(bulk.slices[i]);
            if (isPromise(bulk.slices[i])) {
                bulk.slices[i].then((bulkPromise => slice => {
                    const j = bulk.slices.indexOf(bulkPromise);
                    bulk.slices[j] = slice;
                })(bulk.slices[i]));
            }
        }
        return bulk;
    }

    static createAssets (bulk) {
        const assets = bulk.slices.map(BulkSlice.createAsset);
        return {
            assetIds: assets.map(asset => asset.assetId),
            assets,
        };
    }

    createAssets () {
        return Bulk.createAssets(this);
    }

    add (asset, offset = 0) {
        if (this.slices.length === 0) {
            this.slices.unshift(new BulkSlice());
        }

        // this.table[asset.assetId] = this.table[asset.assetId] || {
        //     assetId: asset.assetId,
        //     dataFormat: asset.dataFormat,
        //     dataSize: asset.data.length,
        //     slices: []
        // };
        // this.table[asset.assetId].slices.push(this.slices.length);

        const written = this.slices[0].add(asset, offset);

        if (offset + written < asset.data.length) {
            this.slices.unshift(new BulkSlice());
            this.add(asset, offset + written);
        }
    }

    find (assetId) {
        const search = () => {
            const pieces = [];
            let size = 0;
            let available = 0;
            for (let i = 0; i < this.slices.length; i++) {
                if (typeof this.slices[i].then === 'function') continue;

                const piece = this.slices[i].find(assetId);
                if (piece) {
                    size = piece.dataSize;
                    available += piece.bulkEnd - piece.bulkOffset;
                    pieces.unshift([piece, this.slices[i]]);
                } else if (pieces.length > 0) {
                    break;
                }
            }

            if (pieces.length > 0 && size !== available) {
                return build(pieces);
            } else if (this.slices.some(isPromise)) {
                return Promise.race(this.slices.filter(isPromise))
                .then(search);
            }

            return null;
        };

        const build = (pieces) => {
            if (pieces.length) {
                const data = new Uint8Array(pieces[0][0].dataSize);
                for (let i = 0; i < pieces.length; i++) {
                    const [piece, slice] = pieces[i];
                    data.set(new Uint8Array(slice.buffer, piece.bulkOffset, piece.bulkEnd - piece.bulkOffset), piece.dataOffset);
                }
                return {
                    assetId,
                    dataFormat: pieces[0][0].dataFormat,
                    data
                };
            }
            return null;
        };

        return search();
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
        if (isPromise(asset)) return asset.then(BulkSlice.fromAsset);

        const slice = new BulkSlice();

        const data = asset.data.buffer ? asset.data : new Uint8Array(asset.data);
        const writeIndex = new Uint32Array(data.buffer, data.length - TAIL_INDEX_SIZE)[0];
        const decodedTail = new TextDecoder().decode(new Uint8Array(data.buffer, writeIndex, data.length - TAIL_INDEX_SIZE - writeIndex));

        slice.bytes.set(new Uint8Array(data.buffer, 0, writeIndex));
        slice.table = JSON.parse(decodedTail);
        slice.writeIndex = writeIndex;

        return slice;
    }

    static createAsset (slice) {
        const encodedTail = new TextEncoder().encode(JSON.stringify(slice.table));

        const data = new Uint8Array(slice.writeIndex + slice.tailSize + TAIL_INDEX_SIZE);
        data.set(new Uint8Array(slice.buffer, 0, slice.writeIndex));
        data.set(encodedTail, slice.writeIndex);
        data.set(new Uint8Array(new Uint32Array([slice.writeIndex]).buffer), slice.writeIndex + slice.tailSize);

        const asset = new Asset({}, null, {}, data, true);
        return {
            assetId: asset.assetId,
            dataFormat: 'bulk',
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
            assetId: asset.assetId,
            dataFormat: asset.dataFormat,
            dataOffset: offset,
            dataSize: data.length,
            bulkOffset: this.writeIndex,
            bulkEnd: -1
        };
        this.tailSize = new TextEncoder().encode(JSON.stringify(this.table)).byteLength;
        this.maxBodySize = MAX_BUFFER_SIZE - this.tailSize - TAIL_INDEX_SIZE;

        const written = Math.min(asset.data.length - offset, this.maxBodySize - this.writeIndex);
        this.bytes.set(new Uint8Array(data.buffer, offset, written), this.writeIndex);
        this.writeIndex += written;
        return written;
    }

    find (assetId) {
        if (this.table[assetId]) {
            if (this.table[assetId].bulkEnd === -1) {
                let bulkEnd = this.writeIndex;
                const tableAssets = Object.values(this.table);
                const assetIndex = tableAssets.indexOf(this.table[assetId]);
                if (assetIndex < tableAssets.length - 1) {
                    bulkEnd = tableAssets[assetIndex].bulkOffset;
                }
                return Object.assign({}, this.table[assetId], {
                    bulkEnd
                });
            }
            return this.table[assetId];
        }
        return null;
    }
}

module.exports = {
    Bulk,
    BulkSlice
};
