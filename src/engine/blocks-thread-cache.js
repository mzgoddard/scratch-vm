const BlocksExecuteCache = require('./blocks-execute-cache');

const STEP_THREAD_METHOD = {
    NEXT: 0,
    POP: 1,
    POP_EXECUTION_CONTEXT: 2,
    POP_PARAMS: 3
};

class Pointer {
    constructor (container, blockId, index) {
        this.container = container;
        this.blockId = blockId;
        this.index = index;

        this.blockInitialized = false;
        this.block = null;

        this.isLoop = false;

        this.executeInitialized = false;
        this.executeCached = null;

        this.nextInitialized = false;
        this.next = null;

        this.branchesInitialized = false;
        this.branches = null;

        this.procedureInitialized = false;
        this.procedureDefinition = null;
        this.procedureInnerBlock = null;

        this.stepThreadInitialized = false;
        this._stepThread = null;
    }

    get STEP_THREAD_METHOD () {
        return STEP_THREAD_METHOD;
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

    getPrevious () {
        return this.previous;
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

exports.getCached = function () {
    throw new Error('blocks.js has not initialized BlocksThreadCache');
};

exports.Pointer = Pointer;

// Call after the default throwing getCached is assigned for Blocks to replace.
require('./blocks');
