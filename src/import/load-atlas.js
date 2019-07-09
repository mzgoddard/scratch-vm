class Asset {
    constructor ({assetId, dataFormat}) {
        this.assetId = assetId;
        this.dataFormat = dataFormat;

        this.promise = null;
        this.canvas = null;
        this.context = null;
    }

    loadCanvas (canvas) {
        if (canvas && !this.promise) {
            this.promise = Promise.resolve(canvas)
            .then(canvas => {
                this.canvas = canvas;
                this.context = canvas.getContext('2d');
                // try {
                // this.imageData = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height);
                // } catch (e) {
                //     console.error(e.stack);
                // }
                return this;
            });
        }
        return this.promise;
    }

    getImageData (left = 0, top = 0, width = this.canvas.width - left, height = this.canvas.height - top) {
        // try {
        // const imageData = new ImageData(width, height);
        // const bottom = top - height;
        // const data = imageData.data;
        // const Data = this.imageData.data;
        // const left4 = left * 4;
        // const bottom4 = bottom * 4;
        // const width4 = width * 4;
        // const Width4 = this.imageData.width * 4;
        // const height4 = height * 4;
        // for (let y = 0; y < height; y++) {
        //     const y4 = y * width4;
        //     const Y4 = (y + bottom) * Width4 + left4;
        //     for (let x4 = 0; x4 < width4; x4 += 4) {
        //         const i = y4 + x4;
        //         const I = Y4 + x4;
        //         data[i + 0] = Data[I + 0];
        //         data[i + 1] = Data[I + 1];
        //         data[i + 2] = Data[I + 2];
        //         data[i + 3] = Data[I + 3];
        //     }
        // }
        // return imageData;
        // } catch (e) {
        //     console.error(e.stack);
        // }
        return this.context.getImageData(left, top, width, height);
    }

    putImageData (x, y, width, height, data) {
        if (!this.canvas) {
            if (this.promise) {
                throw new Error('Cannot put image data into loading canvas');
            }

            this.canvas = document.createElement('canvas');
            this.promise = Promise.resolve(this.canvas);
            this.canvas.width = 2048;
            this.canvas.height = 2048;
            this.context = this.canvas.getContext('2d');
        }

        this.context.putImageData(x, y, width, height, data);
    }

    toDataURL () {
        return this.canvas.toDataURL();
    }

    toDataArray () {
        const url = this.toDataURL();
        const content = url.split(/^[^,]+,/)[1];
        const utfBytes = btoa(content);
        const bytes = new Uint8Array(utfBytes.length);

        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = utfBytes.charCodeAt(i);
        }

        return bytes;
    }
}

class MapTile {
    constructor ({width, height, top, left}) {
        this.width = width;
        this.height = height;
        this.top = top;
        this.left = left;
    }

    getImageData (mapAsset) {
        return mapAsset.getImageData(this.left, this.top, this.width, this.height);
    }

    putImageData (mapAsset, data) {
        mapAsset.putImageData(this.left, this.top, this.width, this.height, data);
    }
}

class MapArea {
    findFreeArea (width, height) {
        if (this.subarea) {
            const areaInSub = this.subarea.findFreeArea(width, height);
            if (areaInSub) return areaInSub;
        }

        if (this.width >= width && this.height >= height) {
            const {left, top} = this;
            this.subarea = new MapArea({subarea: this.subarea, width, height: this.height - height, left, top: top + height});
            this.left += width;
            this.width -= width;
            return new MapTile({width, height, top, left});
        }

        return null;
    }
}

class Map {
    constructor ({asset, width, height}) {
        this.asset = asset;
        this.width = width;
        this.height = height;
        this.tiles = [];
        this.area = null;
    }

    createTile (tileData) {
        const tile = new MapTile(tileData);
        this.tiles.push(tile);
        return tile;
    }

    findFreeArea (width, height) {
        return this.area.findFreeArea(width, height);
    }
}

class AtlasTile {
    constructor ({asset, map, tile}) {
        this.asset = asset;
        this.map = map;
        this.tile = tile;
    }

    findFreeArea (atlas, width, height) {
        if (this.map && this.tile) return true;

        for (let i = 0; i < atlas.maps.length; i++) {
            const areaInMap = atlas.maps[i].findFreeArea(width, height);
            if (areaInMap) {
                this.map = atlas.maps[i];
                this.tile = areaInMap;
                return true;
            }
        }

        const map = atlas.createMap({
            asset: atlas.createAsset({
                assetId: `${atlas.maps.length}`,
                dataFormat: 'png'
            }),
            width: 2048,
            height: 2048
        });

        this.map = map;
        this.tile = map.findFreeArea(width, height);
        return true;
    }

    getImageData () {
        return this.tile.getImageData(this.map.asset);
    }

    putImageData (data) {
        return this.tile.putImageData(this.map.asset, data);
    }
}

class Atlas {
    constructor () {
        this.maps = [];
        this.tiles = [];
    }

    createAsset (assetData) {
        return new Asset(assetData);
    }

    createMap (mapData) {
        const map = new Map(mapData);
        this.maps.push(map);
        return map;
    }

    createTile (tileData) {
        const tile = new AtlasTile(tileData);
        this.tiles.push(tile);
        return tile;
    }

    findTile (assetId) {
        for (const tile of this.tiles) {
            if (tile.asset.assetId === assetId) {
                return tile;
            }
        }
        return null;
    }

    findFreeArea (width, height) {
        for (let i = 0; i < this.maps.length; i++) {
            const areaInMap = this.maps[i].findFreeArea(width, height);
            if (areaInMap) return this.createTile({
                asset: this.createAsset(),
                map: this.maps[i],
                tile: areaInMap
            });
        }

        const map = this.createMap({
            asset: this.createAsset({
                assetId: `${this.maps.length}`,
                dataFormat: 'png'
            }),
            width: 2048,
            height: 2048
        });

        return this.createTile({
            asset: this.createAsset(),
            map,
            tile: map.findFreeArea(width, height)
        });
    }

    updateTile (tile, asset) {}

    save (runtime, zipDescs) {
        return saveAtlas(this, runtime, zipDescs);
    }
}

const serializeAtlas = function (atlas) {
    return {
        maps: atlas.maps.map(map => ({
            asset: {
                assetId: map.asset.assetId,
                dataFormat: map.asset.dataFormat
            },
            width: map.width,
            height: map.height,
            tiles: map.tiles.map(tile => atlas.tiles.find(atlasTile => atlasTile.tile === tile)).map(atlasTile => ({
                asset: {
                    assetId: atlasTile.asset.assetId,
                    dataFormat: atlasTile.asset.dataFormat
                },
                width: atlasTile.tile.width,
                height: atlasTile.tile.height,
                top: atlasTile.tile.top,
                left: atlasTile.tile.left
            }))
        }))
    };
};

const deserializeAtlas = function (atlasData) {
    const atlas = new Atlas();

    for (const mapId in atlasData.maps) {
        const mapData = atlasData.maps[mapId];

        const map = atlas.createMap({
            asset: atlas.createAsset(mapData.asset),
            width: mapData.width,
            height: mapData.height
        });

        for (const tileId in mapData.tiles) {
            const tileData = mapData.tiles[tileId];

            const mapTile = map.createTile({
                width: tileData.width,
                height: tileData.height,
                top: tileData.top,
                left: tileData.left
            });

            const atlasTile = atlas.createTile({
                asset: atlas.createAsset(tileData.asset),
                map,
                tile: mapTile,
            });
        }
    }

    return atlas;
};

const saveAtlas = function (atlas, runtime, zipDescs) {
    atlas.tiles.sort((a, b) => {
        if (a.asset.imageData && b.asset.imageData) {
            return b.asset.imageData.width - a.asset.imageData.width;
        } else if (a.asset.imageData) {
            return 1;
        } else if (b.asset.imageData) {
            return -1;
        }
        return 0;
    });

    for (let i = 0; i < atlas.tiles.length; i++) {
        const tile = atlas.tiles[0];
        if (!tile.asset.imageData) continue;
        tile.findFreeArea(atlas, tile.asset.imageData.width, tile.asset.imageData.height);
        tile.putImageData(tile.asset.imageData);
    }

    for (let i = 0; i < atlas.maps.length; i++) {
        const map = atlas.maps[i];
        const data = map.asset.toDataArray();
        const asset = runtime.storage.createAsset(
            runtime.storage.AssetType.ImageBitmap,
            runtime.storage.DataFormat.PNG,
            data, null, true);
        map.asset.assetId = asset.assetId;

        zipDescs.push({
            fileName: `${asset.assetId}.${asset.dataFormat}`,
            fileContent: asset.data
        });

        runtime.bulk = runtime.bulk || new LoadBulk();
        runtime.bulk.add({
            assetId: asset.assetId,
            dataFormat: asset.dataFormat,
            data: asset.data
        });
    }

    return serializeAtlas(atlas);
};

const loadAtlas = function (atlasData, runtime, zip) {
    const atlas = deserializeAtlas(atlasData);

    for (let i = 0; i < atlas.maps.length; i++) {
        const map = atlas.maps[i];
        if (!map.asset.promise) {
            map.asset.loadCanvas(Promise.resolve()
                .then(() => {
                    const assetType = runtime.storage.AssetType.ImageBitmap;
                    const md5 = map.asset.assetId;
                    const dataFormat = map.asset.dataFormat;
                    return runtime.storage.load(assetType, md5, dataFormat);
                })
                .then(asset => (
                    createImageBitmap(
                        new Blob([asset.data], {type: asset.assetType.contentType})
                    )
                ))
                .then(bitmap => {
                    const canvas = document.createElement('canvas');
                    canvas.width = bitmap.width;
                    canvas.height = bitmap.height;
                    canvas.getContext('2d').drawImage(bitmap, 0, 0);
                    return canvas;
                })
            );
        }
    }

    return atlas;
};

module.exports = {
    saveAtlas,
    loadAtlas,
    serializeAtlas,
    deserializeAtlas
};
