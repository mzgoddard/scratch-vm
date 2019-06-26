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

    findFreeArea (width, height) {}
}

class AtlasTile {
    constructor ({asset, map, tile}) {
        this.asset = asset;
        this.map = map;
        this.tile = tile;
    }

    getImageData (mapAsset) {
        return this.tile.getImageData(mapAsset);
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

    findFreeArea (width, height) {}

    updateTile (tile, asset) {}
}

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
}

const loadAtlas = function (atlasData, runtime, zip) {
    return deserializeAtlas(atlasData);
};

module.exports = {
    loadAtlas,
    deserializeAtlas
};
