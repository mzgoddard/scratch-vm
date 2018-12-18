const BlocksExecuteCache = require('./blocks-execute-cache');

class AbstractPointerMixin {
    constructor () {
        throw new Error([
            'Cannot construct an Abstract mixin. Mix it into a concrete class',
            'and construct that object.'
        ].join(' '));
    }
}

class IndexPointer extends AbstractPointerMixin {
    static mixin (prototype) {}

    static init (obj, index) {
        obj.indexInitialized = true;
        obj.index = index;
    }
}

class BlockDataPointer extends AbstractPointerMixin {
    static mixin (prototype) {
        prototype.getBlock = BlockDataPointer.prototype.getBlock;
    }

    static init (obj) {
        this.blockInitialized = false;
        this.block = null;
    }

    getBlock () {
        if (this.blockInitialized === false) {
            this.block = this.container.getBlock(this.blockId);
            this.blockInitialized = true;
        }
        return this.block;
    }
}

class ExecuteCachedPointer extends AbstractPointerMixin {
    static mixin (prototype) {
        prototype.getExecuteCached = ExecuteCachedPointer.prototype.getExecuteCached;
    }

    static init (obj) {
        obj.executeInitialized = false;
        obj.executeCached = null;
    }

    getExecuteCached (runtime, CacheType) {
        if (this.executeInitialized === false) {
            this.executeCached = BlocksExecuteCache.getCached(runtime, this.container, this.blockId, CacheType);
            this.executeInitialized = true;
        }
        return this.executeCached;
    }
}

class GraphPointer extends AbstractPointerMixin {
    static mixin (prototype) {
        prototype.getBranch = GraphPointer.prototype.getBranch;
        prototype._initProcedure = GraphPointer.prototype._initProcedure;
        prototype.getProcedureDefinition = GraphPointer.prototype.getProcedureDefinition;
        prototype.getProcedureInnerBlock = GraphPointer.prototype.getProcedureInnerBlock;
    }

    static init (obj) {
        obj.branchesInitialized = false;
        obj.branches = null;

        obj.procedureInitialized = false;
        obj.procedureDefinition = null;
        obj.procedureInnerBlock = null;
    }

    getBranch (branchNum) {
        if (this.branchesInitialized === false) {
            this.branches = [
                exports.getCached(this.container, this.container.getBranch(this.blockId, 1), this.warpMode),
                exports.getCached(this.container, this.container.getBranch(this.blockId, 2), this.warpMode)
            ];
            this.branchesInitialized = true;
        }
        return this.branches[branchNum - 1];
    }

    _initProcedure () {
        const block = this.container.getBlock(this.blockId);
        const definition = this.container.getProcedureDefinition(block.mutation.proccode);
        this.procedureDefinition = exports.getCached(this.container, definition, this.warpMode);
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

const STEP_THREAD_METHOD = {
    NEXT: 0,
    NEXT_EXECUTION_CONTEXT: 1,
    POP: 2,
    POP_EXECUTION_CONTEXT: 3,
    POP_PARAMS: 4
};

class StepThreadPointer extends AbstractPointerMixin {
    static mixin (prototype) {
        Object.defineProperty(
            prototype,
            'STEP_THREAD_METHOD',
            Object.getOwnPropertyDescriptor(StepThreadPointer.prototype, 'STEP_THREAD_METHOD')
        );
        prototype.getNext = GraphPointer.prototype.getNext;
        prototype._stepThreadNext = StepThreadPointer.prototype._stepThreadNext;
        prototype._stepThreadNextExecutionContext = StepThreadPointer.prototype._stepThreadNextExecutionContext;
        prototype._stepThreadPop = StepThreadPointer.prototype._stepThreadPop;
        prototype._stepThreadPopExecutionContext = StepThreadPointer.prototype._stepThreadPopExecutionContext;
        prototype._stepThreadPopParams = StepThreadPointer.prototype._stepThreadPopParams;
        prototype.setStepThread = StepThreadPointer.prototype.setStepThread;
        prototype.stepThread = StepThreadPointer.prototype.stepThread;
    }

    static init (obj) {
        obj.nextInitialized = false;
        obj.next = null;

        obj.isLoop = false;

        obj.stepThreadInitialized = false;
        obj._stepThread = null;
    }

    getNext () {
        if (this.nextInitialized === false) {
            this.next = exports.getCached(this.container, this.container.getNextBlock(this.blockId), this.warpMode);
            this.nextInitialized = true;
        }
        return this.next;
    }

    get STEP_THREAD_METHOD () {
        return STEP_THREAD_METHOD;
    }

    _stepThreadNext (thread) {
        thread.reuseStackForNextBlock();
    }

    _stepThreadNextExecutionContext (thread) {
        thread.executionContexts.pop();
        thread.shouldPushExecutionContext = true;
        thread.reuseStackForNextBlock();
    }

    _stepThreadPop (thread) {
        thread.popStack();
        const pointer = thread.lastStackPointer;
        if (pointer !== null && !pointer.isLoop) {
            pointer.stepThread(thread);
        }
    }

    _stepThreadPopExecutionContext (thread) {
        thread.executionContexts.pop();
        thread.shouldPushExecutionContext = false;
        this._stepThreadPop(thread);
    }

    _stepThreadPopParams (thread) {
        thread.params.pop();
        this._stepThreadPop(thread);
    }

    setStepThread (method) {
        switch (method) {
        case STEP_THREAD_METHOD.NEXT:
            this._stepThread = this._stepThreadNext;
            this.stepThreadInitialized = true;
            break;

        case STEP_THREAD_METHOD.NEXT_EXECUTION_CONTEXT:
            this._stepThread = this._stepThreadNextExecutionContext;
            break;

        case STEP_THREAD_METHOD.POP:
            this._stepThread = this._stepThreadPop;
            this.stepThreadInitialized = true;
            break;

        case STEP_THREAD_METHOD.POP_EXECUTION_CONTEXT:
            this._stepThread = this._stepThreadPopExecutionContext;
            this.stepThreadInitialized = true;
            break;

        case STEP_THREAD_METHOD.POP_PARAMS:
            this._stepThread = this._stepThreadPopParams;
            this.stepThreadInitialized = true;
            break;

        default:
            throw new Error('Unknown step thread style.');
        }
    }

    stepThread (thread) {
        if (this.stepThreadInitialized === false) {
            const next = this.getNext();
            if (next !== null) {
                this._stepThread = this._stepThreadNext;
            } else if (this._stepThread === this._stepThreadNextExecutionContext) {
                this._stepThread = this._stepThreadPopExecutionContext;
            } else if (this._stepThread === null) {
                this._stepThread = this._stepThreadPop;
            }
            this.stepThreadInitialized = true;
        }

        // console.log(this._stepThread.name);
        this._stepThread(thread);

        return thread.lastStackPointer;
    }
}

class Pointer {
    constructor (container, blockId, index, warpMode) {
        this.container = container;
        this.blockId = blockId;
        this.warpMode = warpMode;

        IndexPointer.init(this, index);
        BlockDataPointer.init(this);
        ExecuteCachedPointer.init(this);
        GraphPointer.init(this);
        StepThreadPointer.init(this, warpMode);
    }
}

IndexPointer.mixin(Pointer.prototype);
BlockDataPointer.mixin(Pointer.prototype);
ExecuteCachedPointer.mixin(Pointer.prototype);
GraphPointer.mixin(Pointer.prototype);
StepThreadPointer.mixin(Pointer.prototype);

exports.getCached = function () {
    throw new Error('blocks.js has not initialized BlocksThreadCache');
};

exports.Pointer = Pointer;

// Call after the default throwing getCached is assigned for Blocks to replace.
require('./blocks');
