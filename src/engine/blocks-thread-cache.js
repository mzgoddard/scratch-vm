const BlocksExecuteCache = require('./blocks-execute-cache');

class Pointer {
    constructor (container, blockId, index) {
        this.container = container;
        this.blockId = blockId;
        this.index = index;

        this.blockInitialized = false;
        this.block = null;

        this.executeInitialized = false;
        this.executeCached = null;

        this.nextInitialized = false;
        this.next = null;

        this.branchesInitialized = false;
        this.branches = null;

        this.procedureInitialized = false;
        this.procedureDefinition = null;
        this.procedureInnerBlock = null;
    }

    getBlock () {
        if (this.blockInitialized === false) {
            this.block = this.container.getBlock(this.blockId);
            this.blockInitialized = true;
        }
        return this.block;
    }

    getExecuteCached (runtime, CacheType) {
        if (this.executeInitialized === false) {
            this.executeCached = BlocksExecuteCache.getCached(runtime, this.container, this.blockId, CacheType);
            this.executeInitialized = true;
        }
        return this.executeCached;
    }

    getNext () {
        if (this.nextInitialized === false) {
            this.next = exports.getCached(this.container, this.container.getNextBlock(this.blockId));
            this.nextInitialized = true;
        }
        return this.next;
    }

    getBranch (branchNum) {
        if (this.branchesInitialized === false) {
            this.branches = [
                exports.getCached(this.container, this.container.getBranch(this.blockId, 1)),
                exports.getCached(this.container, this.container.getBranch(this.blockId, 2))
            ];
            this.branchesInitialized = true;
        }
        return this.branches[branchNum - 1];
    }

    _initProcedure () {
        const block = this.container.getBlock(this.blockId);
        const definition = this.container.getProcedureDefinition(block.mutation.proccode);
        this.procedureDefinition = exports.getCached(this.container, definition);
        const definitionBlock = this.container.getBlock(definition);
        this.procedureInnerBlock = this.container.getBlock(definitionBlock.inputs.custom_block.block);
        this.procedureInitialized = true;
    }

    getProcedureDefinition () {
        if (this.procedureInitialized === false) {
            this._initProcedure();
        }
        return this.procedureDefinition;
    }

    getProcedureInnerBlock () {
        if (this.procedureInitialized === false) {
            this._initProcedure();
        }
        return this.procedureInnerBlock;
    }
}

exports.getCached = function () {
    throw new Error('blocks.js has not initialized BlocksThreadCache');
};

exports.Pointer = Pointer;

// Call after the default throwing getCached is assigned for Blocks to replace.
require('./blocks');
