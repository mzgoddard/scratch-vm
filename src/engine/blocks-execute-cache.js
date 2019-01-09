/**
 * @fileoverview
 * Access point for private method shared between blocks.js and execute.js for
 * caching execute information.
 */

/**
 * A private method shared with execute to build an object containing the block
 * information execute needs and that is reset when other cached Blocks info is
 * reset.
 * @param {Blocks} blocks Blocks containing the expected blockId
 * @param {string} blockId blockId for the desired execute cache
 */
exports.getCached = function () {
    throw new Error('blocks.js has not initialized BlocksExecuteCache');
};

exports.BlocksThreadExecutePointer = class ExecuteCachedPointer {
    static init (_this) {
        _this.executeInitialized = false;
        _this.executeCached = null;
    }

    static getExecuteCached (_this, runtime, CacheType) {
        if (_this.executeInitialized === false) {
            _this.executeCached = exports.getCached(runtime, _this.container, _this.blockId, CacheType);
            _this.executeInitialized = true;
        }
        return _this.executeCached;
    }
};

// Call after the default throwing getCached is assigned for Blocks to replace.
require('./blocks');
