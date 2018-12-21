const BlocksThreadCache = require('./blocks-thread-cache');

const {
    Block: {
        getBlock: getPointerBlock
    },
    Graph: {
        getBranch: getBranchPointer,
        getProcedureDefinition: getProcedureDefinitionPointer,
        getProcedureParamNamesIdsAndDefaults: getProcedureParamNamesIdsAndDefaults,
        getProcedureInnerBlock
    },
    Increment: {
        increment: incrementPointer,
        incrementPop: incrementPopPointer
    }
} = BlocksThreadCache;

/**
 * Recycle bin for empty stackFrame objects
 * @type Array<_StackFrame>
 */
const _stackFrameFreeList = [];

/**
 * A frame used for each level of the stack. A general purpose
 * place to store a bunch of execution context and parameters
 * @param {boolean} warpMode Whether this level of the stack is warping
 * @constructor
 * @private
 */
class _StackFrame {
    constructor (id, warpMode) {
        this.id = id;

        /**
         * Whether this level of the stack is a loop.
         * @type {boolean}
         */
        this.isLoop = false;

        /**
         * Whether this level is in warp mode.  Is set by some legacy blocks and
         * "turbo mode"
         * @type {boolean}
         */
        this.warpMode = warpMode;

        /**
         * Procedure parameters.
         * @type {Object}
         */
        // this.params = null;

        /**
         * A context passed to block implementations.
         * @type {Object}
         */
        this.executionContext = null;
    }

    /**
     * Reset all properties of the frame to pristine null and false states.
     * Used to recycle.
     * @return {_StackFrame} this
     */
    reset () {

        this.isLoop = false;
        // this.warpMode = false;
        // this.params = null;
        this.executionContext = null;

        return this;
    }

    /**
     * Reuse an active stack frame in the stack.
     * @param {?boolean} warpMode defaults to current warpMode
     * @returns {_StackFrame} this
     */
    reuse (id) {
        this.reset();
        this.id = id;
        return this;
    }

    /**
     * Create or recycle a stack frame object.
     * @param {boolean} warpMode Enable warpMode on this frame.
     * @returns {_StackFrame} The clean stack frame with correct warpMode setting.
     */
    static create (id, warpMode) {
        if (_stackFrameFreeList.length > 0) {
            const stackFrame = _stackFrameFreeList.pop();
            stackFrame.id = id;
            stackFrame.warpMode = Boolean(warpMode);
            return stackFrame;
        }
        return new _StackFrame(id, warpMode);
    }

    /**
     * Put a stack frame object into the recycle bin for reuse.
     * @param {_StackFrame} stackFrame The frame to reset and recycle.
     */
    static release (stackFrame) {
        if (typeof stackFrame !== 'undefined' && stackFrame !== null) {
            // stackFrame.isLoop = false;
            // stackFrame.params = null;
            _stackFrameFreeList.push(stackFrame.reset());
        } else {
            throw new Error('Trying to release undefined or null');
        }
    }
}

/**
 * A thread is a running stack context and all the metadata needed.
 * @param {?string} firstBlock First block to execute in the thread.
 * @constructor
 */
class Thread {
    constructor (firstBlock) {
        /**
         * ID of top block of the thread
         * @type {!string}
         */
        this.topBlock = firstBlock;

        /**
         * Stack for the thread. When the sequencer enters a control structure,
         * the block is pushed onto the stack so we know where to exit.
         * @type {Array.<string>}
         */
        this.stack = [];

        /**
         * Stack frames for the thread. Store metadata for the executing blocks.
         * @type {Array.<_StackFrame>}
         */
        this.stackFrames = [];

        this.pointer = null;

        /**
         * Status of the thread, one of three states (below)
         * @type {number}
         */
        this.status = 0; /* Thread.STATUS_RUNNING */

        /**
         * Whether the thread is killed in the middle of execution.
         * @type {boolean}
         */
        this.isKilled = false;

        /**
         * Target of this thread.
         * @type {?Target}
         */
        this.target = null;

        /**
         * The Blocks this thread will execute.
         * @type {Blocks}
         */
        this.blockContainer = null;

        /**
         * Whether the thread requests its script to glow during this frame.
         * @type {boolean}
         */
        this.requestScriptGlowInFrame = false;

        /**
         * Which block ID should glow during this frame, if any.
         * @type {?string}
         */
        this.blockGlowInFrame = null;

        /**
         * A timer for when the thread enters warp mode.
         * Substitutes the sequencer's count toward WORK_TIME on a per-thread basis.
         * @type {?Timer}
         */
        this.warpTimer = null;

        /**
         * ...
         * @type {string}
         */
        this.reporting = null;

        /**
         * Persists reported inputs during async block.
         * @type {Object}
         */
        this.reported = null;

        /**
         * Reported value from just executed block.
         * @type {Any}
         */
        this.justReported = null;

        // this.popPointerMethod = [];

        this.paramStack = [];
        this.params = {};

        this.executionContexts = [];
        this.executionContext = null;
    }

    /**
     * Time to run a warp-mode thread, in ms.
     * @type {number}
     */
    static get WARP_TIME () {
        return 500;
    }

    /**
     * Thread status for initialized or running thread.
     * This is the default state for a thread - execution should run normally,
     * stepping from block to block.
     * @const
     */
    static get STATUS_RUNNING () {
        return 0;
    }

    /**
     * Threads are in this state when a primitive is waiting on a promise;
     * execution is paused until the promise changes thread status.
     * @const
     */
    static get STATUS_PROMISE_WAIT () {
        return 1;
    }

    /**
     * Thread status for yield.
     * @const
     */
    static get STATUS_YIELD () {
        return 2;
    }

    /**
     * Thread status for a single-tick yield. This will be cleared when the
     * thread is resumed.
     * @const
     */
    static get STATUS_YIELD_TICK () {
        return 3;
    }

    /**
     * Thread status for a finished/done thread.
     * Thread is in this state when there are no more blocks to execute.
     * @const
     */
    static get STATUS_DONE () {
        return 4;
    }

    /**
     * Push stack and update stack frames appropriately.
     * @param {string} blockId Block ID to push to stack.
     */
    pushStack (blockId) {
        // Push an empty stack frame, if we need one.
        // Might not, if we just popped the stack.
        if (this.pointer !== null) {
            this.stackFrames.push(this.pointer);
        }
        const parent = this.stackFrames[this.stackFrames.length - 1];
        this.pointer = _StackFrame.create(blockId, typeof parent !== 'undefined' && parent.warpMode);
    }

    initPointer (blockId) {
        this.pointer = BlocksThreadCache.getCached(this.blockContainer, blockId);
    }

    incrementPointer () {
        incrementPointer(this);
    }

    pushProcedurePointer (blockId) {
        if (this.executionContext !== null) {
            this.pointer.popExecution = true;
            this.executionContexts.push(this.executionContext);
            this.executionContext = null;
        }

        const parent = this.pointer;
        this.stackFrames.push(parent);
        this.pointer = blockId;
    }

    pushBranchPointer (blockId, isLoop) {
        if (this.executionContext !== null) {
            this.pointer.popExecution = true;
            this.executionContexts.push(this.executionContext);
            this.executionContext = null;
        }

        const parent = this.pointer;
        this.stackFrames.push(parent);
        this.pointer = blockId;
    }

    /**
     * Reset the stack frame for use by the next block.
     * (avoids popping and re-pushing a new stack frame - keeps the warpmode the same
     * @param {string} blockId Block ID to push to stack.
     */
    reuseStackForNextBlock (blockId) {
        this.pointer.reuse(blockId);
    }

    popPointer () {
        incrementPopPointer(_this);
    }

    /**
     * Pop last block on the stack and its stack frame.
     * @return {string} Block ID popped from the stack.
     */
    popStack () {
        const id = this.pointer.blockId;
        this.popPointer();
        return id;
    }

    /**
     * Pop back down the stack frame until we hit a procedure call or the stack frame is emptied
     */
    stopThisScript () {
        let blockID = this.pointer;
        while (blockID !== null) {
            const block = getPointerBlock(blockID);
            if (typeof block !== 'undefined' && block.opcode === 'procedures_call') {
                break;
            }
            this.popPointer();
            blockID = this.pointer;
        }

        if (this.stackFrames.length === 0) {
            // Clean up!
            this.requestScriptGlowInFrame = false;
            this.status = Thread.STATUS_DONE;
        }
    }

    /**
     * Get top stack item.
     * @return {?string} Block ID on top of stack.
     */
    peekStack () {
        return this.pointer;
    }


    /**
     * Get top stack frame.
     * @return {?object} Last stack frame stored on this thread.
     */
    peekStackFrame () {
        return this.pointer;
    }

    /**
     * Get stack frame above the current top.
     * @return {?object} Second to last stack frame stored on this thread.
     */
    peekParentStackFrame () {
        return this.stackFrames.length > 0 ? this.stackFrames[this.stackFrames.length - 1] : null;
    }

    /**
     * Returns the execution context of the current stack frame or creates one
     * if it does not yet exist.
     * @return {object} Execution context
     */
    peekExecutionContext () {
        if (this.executionContext === null) {
            this.executionContext = {};
        }
        return this.executionContext;
    }

    /**
     * Push a reported value to the parent of the current stack frame.
     * @param {*} value Reported value to push.
     */
    pushReportedValue (value) {
        this.justReported = typeof value === 'undefined' ? null : value;
    }

    initParams () {
        this.paramStack.push(this.params);
        this.params = {};
    }

    /**
     * Initialize procedure parameters on this stack frame.
     */
    initParams () {
        const stackFrame = this.peekStackFrame();
        if (stackFrame.params === null) {
            stackFrame.params = {};
        }
    }

    /**
     * Add a parameter to the stack frame.
     * Use when calling a procedure with parameter values.
     * @param {!string} paramName Name of parameter.
     * @param {*} value Value to set for parameter.
     */
    pushParam (paramName, value) {
        this.params[paramName] = value;
    }

    /**
     * Get a parameter at the lowest possible level of the stack.
     * @param {!string} paramName Name of parameter.
     * @return {*} value Value for parameter.
     */
    getParam (paramName) {
        if (this.params.hasOwnProperty(paramName)) {
            return this.params[paramName];
        }
        return null;
    }

    /**
     * Whether the current execution of a thread is at the top of the stack.
     * @return {boolean} True if execution is at top of the stack.
     */
    atStackTop () {
        return this.pointer.blockId === this.topBlock;
    }


    /**
     * Switch the thread to the next block at the current level of the stack.
     * For example, this is used in a standard sequence of blocks,
     * where execution proceeds from one block to the next.
     */
    goToNextBlock () {
        const nextBlockId = IncrementThreadCache.getNext(this.peekStack());
        this.reuseStackForNextBlock(nextBlockId);
    }

    /**
     * Attempt to determine whether a procedure call is recursive,
     * by examining the stack.
     * @param {!string} procedureCode Procedure code of procedure being called.
     * @return {boolean} True if the call appears recursive.
     */
    isRecursiveCall (definition) {
        let callCount = 5; // Max number of enclosing procedure calls to examine.
        const sp = this.stackFrames.length;
        for (let i = sp - 1; i >= 0; i--) {
            if (getProcedureDefinitionPointer(this.stackFrames[i]) === definition) {
                return true;
            }
            if (--callCount < 0) return false;
        }
        return false;
    }

    /**
     * Step a thread into a block's branch.
     * @param {number} branchNum Which branch to step to (i.e., 1, 2).
     * @param {boolean} isLoop Whether this block is a loop.
     */
    stepToBranch (branchNum, isLoop) {
        if (!branchNum) {
            branchNum = 1;
        }
        const branchId = getBranchPointer(this.pointer, branchNum);
        this.pointer.isLoop = isLoop;
        if (branchId) {
            // Push branch ID to the this's stack.
            this.pushBranchPointer(branchId);
        } else {
            this.pushBranchPointer(null);
        }
    }

    /**
     * Step a procedure.
     * @param {!string} procedureCode Procedure code of procedure to step to.
     */
    stepToProcedure () {
        const currentBlockId = this.pointer;
        const definition = getProcedureDefinitionPointer(currentBlockId);
        if (!definition) {
            return;
        }
        // To step to a procedure, we put its definition on the stack.
        // Execution for the this will proceed through the definition hat
        // and on to the main definition of the procedure.
        // When that set of blocks finishes executing, it will be popped
        // from the stack by the sequencer, returning control to the caller.
        this.pushProcedurePointer(definition);
        // In known warp-mode thiss, only yield when time is up.
        if (currentBlockId.warpMode &&
            this.warpTimer.timeElapsed() > Thread.WARP_TIME) {
            this.status = this.STATUS_YIELD;
        } else {
            // Look for warp-mode flag on definition, and set the this
            // to warp-mode if needed.
            const definitionBlock = getPointerBlock(definition);
            const innerBlock = getProcedureInnerBlock(currentBlockId);
            let doWarp = false;
            if (innerBlock && innerBlock.mutation) {
                const warp = innerBlock.mutation.warp;
                if (typeof warp === 'boolean') {
                    doWarp = warp;
                } else if (typeof warp === 'string') {
                    doWarp = JSON.parse(warp);
                }
            }
            if (doWarp) {
                this.pointer.warpMode = true;
            } else {
                // Check if the call is recursive.
                // If so, set the this to yield after pushing.
                const isRecursive = this.isRecursiveCall(definition);
                if (isRecursive) {
                    // In normal-mode this, yield any time we have a recursive
                    // call.
                    this.status = this.STATUS_YIELD;
                }
            }
        }
    }

    getProcedureParamNamesIdsAndDefaults () {
        return getProcedureParamNamesIdsAndDefaults(this.pointer);
    }
}

module.exports = Thread;
