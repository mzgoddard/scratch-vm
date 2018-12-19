const {BlocksThreadExecutePointer} = require('./blocks-execute-cache');

class AbstractPointerMixin {
    constructor () {
        throw new Error([
            'Cannot construct an Abstract mixin. Mix it into a concrete class',
            'and construct that object.'
        ].join(' '));
    }
}

class IndexPointer extends AbstractPointerMixin {
    static init (obj, index) {
        obj.indexInitialized = true;
        obj.index = index;
    }
}

class BlockDataPointer extends AbstractPointerMixin {
    static init (_this) {
        _this.blockInitialized = false;
        _this.block = null;
    }

    static getBlock (_this) {
        if (_this.blockInitialized === false) {
            _this.block = _this.container.getBlock(_this.blockId);
            _this.blockInitialized = true;
        }
        return _this.block;
    }
}

class GraphPointer extends AbstractPointerMixin {
    static mixin (prototype) {
        prototype.getBranch = GraphPointer.prototype.getBranch;
        prototype._initProcedure = GraphPointer.prototype._initProcedure;
        prototype.getProcedureDefinition = GraphPointer.prototype.getProcedureDefinition;
        prototype.getProcedureInnerBlock = GraphPointer.prototype.getProcedureInnerBlock;
    }

    static init (_this) {
        _this.branchesInitialized = false;
        _this.branches = null;

        _this.procedureInitialized = false;
        _this.procedureDefinition = null;
        _this.procedureInnerBlock = null;
    }

    static getBranch (_this, branchNum) {
        if (_this.branchesInitialized === false) {
            _this.branches = [
                exports.getCached(_this.container, _this.container.getBranch(_this.blockId, 1), _this.warpMode),
                exports.getCached(_this.container, _this.container.getBranch(_this.blockId, 2), _this.warpMode)
            ];
            _this.branchesInitialized = true;
        }
        return _this.branches[branchNum - 1];
    }

    static _initProcedure (_this) {
        const block = _this.container.getBlock(_this.blockId);
        const definition = _this.container.getProcedureDefinition(block.mutation.proccode);
        _this.procedureDefinition = exports.getCached(_this.container, definition, _this.warpMode);
        const definitionBlock = _this.container.getBlock(definition);
        _this.procedureInnerBlock = _this.container.getBlock(definitionBlock.inputs.custom_block.block);
        _this.procedureInitialized = true;
    }

    static getProcedureDefinition (_this) {
        if (_this.procedureInitialized === false) {
            GraphPointer._initProcedure(_this);
        }
        return _this.procedureDefinition;
    }

    static getProcedureInnerBlock (_this) {
        if (_this.procedureInitialized === false) {
            GraphPointer._initProcedure(_this);
        }
        return _this.procedureInnerBlock;
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

    static init (_this) {
        _this.nextInitialized = false;
        _this.next = null;

        _this.isLoop = false;

        _this.stepThreadInitialized = false;
        _this._stepThread = null;
    }

    static getNext (_this) {
        if (_this.nextInitialized === false) {
            _this.next = exports.getCached(_this.container, _this.container.getNextBlock(_this.blockId), _this.warpMode);
            _this.nextInitialized = true;
        }
        return _this.next;
    }

    static get STEP_THREAD_METHOD () {
        return STEP_THREAD_METHOD;
    }

    static _stepThreadNext (_this, thread) {
        thread.reuseStackForNextBlock();
    }

    static _stepThreadNextExecutionContext (_this, thread) {
        thread.executionContexts.pop();
        thread.shouldPushExecutionContext = true;
        thread.reuseStackForNextBlock();
    }

    static _stepThreadPop (_this, thread) {
        thread.popStack();
        const pointer = thread.lastStackPointer;
        if (pointer !== null && !pointer.isLoop) {
            pointer.stepThread(thread);
        }
    }

    static _stepThreadPopExecutionContext (_this, thread) {
        thread.executionContexts.pop();
        thread.shouldPushExecutionContext = false;
        _this._stepThreadPop(thread);
    }

    static _stepThreadPopParams (_this, thread) {
        thread.params.pop();
        _this._stepThreadPop(thread);
    }

    static setStepThread (_this, method) {
        switch (method) {
        case STEP_THREAD_METHOD.NEXT:
            _this._stepThread = _this._stepThreadNext;
            _this.stepThreadInitialized = true;
            break;

        case STEP_THREAD_METHOD.NEXT_EXECUTION_CONTEXT:
            _this._stepThread = _this._stepThreadNextExecutionContext;
            break;

        case STEP_THREAD_METHOD.POP:
            _this._stepThread = _this._stepThreadPop;
            _this.stepThreadInitialized = true;
            break;

        case STEP_THREAD_METHOD.POP_EXECUTION_CONTEXT:
            _this._stepThread = _this._stepThreadPopExecutionContext;
            _this.stepThreadInitialized = true;
            break;

        case STEP_THREAD_METHOD.POP_PARAMS:
            _this._stepThread = _this._stepThreadPopParams;
            _this.stepThreadInitialized = true;
            break;

        default:
            throw new Error('Unknown step thread style.');
        }
    }

    static stepThread (_this, thread) {
        if (_this.stepThreadInitialized === false) {
            const next = StepThreadPointer.getNext(_this);
            if (next !== null) {
                _this._stepThread = _this._stepThreadNext;
            } else if (_this._stepThread === _this._stepThreadNextExecutionContext) {
                _this._stepThread = _this._stepThreadPopExecutionContext;
            } else if (_this._stepThread === null) {
                _this._stepThread = _this._stepThreadPop;
            }
            _this.stepThreadInitialized = true;
        }

        // console.log(_this._stepThread.name);
        _this._stepThread(thread);

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
        BlocksThreadExecutePointer.init(this);
        GraphPointer.init(this);
        StepThreadPointer.init(this);
    }
}

// IndexPointer.mixin(Pointer.prototype);
// BlockDataPointer.mixin(Pointer.prototype);
// ExecuteCachedPointer.mixin(Pointer.prototype);
// GraphPointer.mixin(Pointer.prototype);
// StepThreadPointer.mixin(Pointer.prototype);

exports.getCached = function () {
    throw new Error('blocks.js has not initialized BlocksThreadCache');
};

exports.Pointer = Pointer;

exports.Index = IndexPointer;
exports.Block = BlockDataPointer;
exports.Graph = GraphPointer;
exports.Increment = StepThreadPointer;

// Call after the default throwing getCached is assigned for Blocks to replace.
require('./blocks');
