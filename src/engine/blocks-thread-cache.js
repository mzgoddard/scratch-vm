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

    static getBranch (branchNum) {
        if (_this.branchesInitialized === false) {
            _this.branches = [
                exports.getCached(_this.container, _this.container.getBranch(_this.blockId, 1), _this.warpMode),
                exports.getCached(_this.container, _this.container.getBranch(_this.blockId, 2), _this.warpMode)
            ];
            _this.incrementPop = StepThreadPointer.popBranch;
            _this.branchesInitialized = true;
        }
        return _this.branches[branchNum - 1];
    }

    static _initProcedure () {
        const block = _this.container.getBlock(_this.blockId);
        const definition = _this.container.getProcedureDefinition(block.mutation.proccode);
        _this.procedureDefinition = exports.getCached(_this.container, definition, _this.warpMode);
        if (_this.procedureDefinition) {
            _this.incrementPop = StepThreadPointer.popProcedure;
        }
        const definitionBlock = _this.container.getBlock(definition);
        _this.procedureInnerBlock = _this.container.getBlock(definitionBlock.inputs.custom_block.block);
        _this.procedureInitialized = true;
    }

    static getProcedureDefinition () {
        if (_this.procedureInitialized === false) {
            _this._initProcedure();
        }
        return _this.procedureDefinition;
    }

    static getProcedureInnerBlock () {
        if (_this.procedureInitialized === false) {
            _this._initProcedure();
        }
        return _this.procedureInnerBlock;
    }
}

const STEP_THREAD_METHOD = {
    NEXT: '_next',
    POP_INIT: '_popInit',
    POP_PROCEDURE: '_popProcedure',
    POP_BRANCH: '_popBranch'
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

        _this.popExecution = false;
        _this.increment = _this.container.getNextBlock(_this.blockId) ?
            StepThreadPointer._next :
            StepThreadPointer._pop;
        _this.incrementPop = StepThreadPointer.popInit;
    }

    static getNext (_this) {
        if (_this.nextInitialized === false) {
            _this.next = exports.getCached(_this.container, _this.container.getNextBlock(_this.blockId), _this.warpMode);
            _this.nextInitialized = true;
        }
        return _this.next;
    }

    static _next (thread) {
        thread.pointer = StepThreadPointer.getNext(thread.pointer);
        thread.executionContext = null;
    }

    static _pop (thread) {
        thread.pointer = thread.stackFrames.pop() || null;
        if (thread.pointer) {
            thread.pointer.incrementPop(thread);
            if (!thread.pointer.isLoop) {
                thread.pointer.increment(thread);
            }
        } else {
            thread.params = null;
            thread.executionContext = null;
        }
    }

    static popInit (thread) {
        thread.pointer = null;
        thread.params = null;
        thread.executionContext = null;
    }

    static popProcedure (thread) {
        thread.params = thread.paramStack.pop();
        if (thread.pointer.popExecution) {
            thread.executionContext = thread.executionContexts.pop();
        } else {
            thread.executionContext = null;
        }
    }

    static popBranch (thread) {
        if (thread.pointer.popExecution) {
            thread.executionContext = thread.executionContexts.pop();
        } else {
            thread.executionContext = null;
        }
    }

    static increment (thread) {
        thread.pointer.increment(thread);
    }

    static incrementPop (thread) {
        thread.pointer.incrementPop(thread);
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
