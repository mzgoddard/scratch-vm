const ThreadTreeCache = require('./blocks-thread-tree-cache');

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
    constructor (warpMode) {
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
         * Reported value from just executed block.
         * @type {Any}
         */
        this.justReported = null;

        /**
         * Persists reported inputs during async block.
         * @type {Object}
         */
        this.reported = null;

        /**
         * Name of waiting reporter.
         * @type {string}
         */
        this.waitingReporter = null;

        /**
         * Procedure parameters.
         * @type {Object}
         */
        this.params = null;

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
        this.warpMode = false;
        this.justReported = null;
        this.reported = null;
        this.waitingReporter = null;
        this.params = null;
        this.executionContext = null;

        return this;
    }

    /**
     * Reuse an active stack frame in the stack.
     * @param {?boolean} warpMode defaults to current warpMode
     * @returns {_StackFrame} this
     */
    reuse (warpMode = this.warpMode) {
        this.reset();
        this.warpMode = Boolean(warpMode);
        return this;
    }

    /**
     * Create or recycle a stack frame object.
     * @param {boolean} warpMode Enable warpMode on this frame.
     * @returns {_StackFrame} The clean stack frame with correct warpMode setting.
     */
    static create (warpMode) {
        const stackFrame = _stackFrameFreeList.pop();
        if (typeof stackFrame !== 'undefined') {
            stackFrame.warpMode = Boolean(warpMode);
            return stackFrame;
        }
        return new _StackFrame(warpMode);
    }

    /**
     * Put a stack frame object into the recycle bin for reuse.
     * @param {_StackFrame} stackFrame The frame to reset and recycle.
     */
    static release (stackFrame) {
        if (typeof stackFrame !== 'undefined') {
            _stackFrameFreeList.push(stackFrame.reset());
        }
    }
}

/**
 * A thread is a running stack context and all the metadata needed.
 * @param {?string} firstBlock First block to execute in the thread.
 * @constructor
 */
class Thread {
    constructor (blockContainer, firstBlock) {
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

        this.stackPointer = ThreadTreeCache.getCached(blockContainer, firstBlock);
        console.log(this.stackPointer);

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
        this.blockContainer = blockContainer;

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
        this.stack.push(blockId);

        // this.stackPointer = this.stackPointer.fromHere[blockId];
        // if (this.stackPointer === null) {
        //    this.stackPointer = ThreadTreeCache.getCached(this.blockContainer, nextBlockId);
        // }

        // Push an empty stack frame, if we need one.
        // Might not, if we just popped the stack.
        if (this.stack.length > this.stackFrames.length) {
            const parent = this.stackFrames[this.stackFrames.length - 1];
            this.stackFrames.push(_StackFrame.create(typeof parent !== 'undefined' && parent.warpMode));
        }
    }

    /**
     * Reset the stack frame for use by the next block.
     * (avoids popping and re-pushing a new stack frame - keeps the warpmode the same
     * @param {string} blockId Block ID to push to stack.
     */
    reuseStackForNextBlock (blockId) {
        this.stack[this.stack.length - 1] = blockId;
        this.stackFrames[this.stackFrames.length - 1].reuse();
    }

    /**
     * Pop last block on the stack and its stack frame.
     * @return {string} Block ID popped from the stack.
     */
    popStack () {
        // this.stackPointer = ThreadTreeCache.getCached(this.blockContainer, nextBlockId);

        _StackFrame.release(this.stackFrames.pop());
        return this.stack.pop();
    }

    /**
     * Pop back down the stack frame until we hit a procedure call or the stack frame is emptied
     */
    stopThisScript () {
        let blockID = this.peekStack();
        while (blockID !== null) {
            const block = this.blockContainer.getBlock(blockID);
            if (typeof block !== 'undefined' && block.opcode === 'procedures_call') {
                break;
            }
            this.popStack();
            blockID = this.peekStack();
        }

        if (this.stack.length === 0) {
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
        return this.stack.length > 0 ? this.stack[this.stack.length - 1] : null;
    }


    /**
     * Get top stack frame.
     * @return {?object} Last stack frame stored on this thread.
     */
    peekStackFrame () {
        return this.stackFrames.length > 0 ? this.stackFrames[this.stackFrames.length - 1] : null;
    }

    /**
     * Get stack frame above the current top.
     * @return {?object} Second to last stack frame stored on this thread.
     */
    peekParentStackFrame () {
        return this.stackFrames.length > 1 ? this.stackFrames[this.stackFrames.length - 2] : null;
    }

    /**
     * Push a reported value to the parent of the current stack frame.
     * @param {*} value Reported value to push.
     */
    pushReportedValue (value) {
        const parentStackFrame = this.peekParentStackFrame();
        if (parentStackFrame !== null) {
            parentStackFrame.justReported = typeof value === 'undefined' ? null : value;
        }
    }

    /**
     * Add a parameter to the stack frame.
     * Use when calling a procedure with parameter values.
     * @param {!string} paramName Name of parameter.
     * @param {*} value Value to set for parameter.
     */
    pushParam (paramName, value) {
        const stackFrame = this.peekStackFrame();
        if (stackFrame.params === null) {
            stackFrame.params = {};
        }
        stackFrame.params[paramName] = value;
    }

    /**
     * Get a parameter at the lowest possible level of the stack.
     * @param {!string} paramName Name of parameter.
     * @return {*} value Value for parameter.
     */
    getParam (paramName) {
        for (let i = this.stackFrames.length - 1; i >= 0; i--) {
            const frame = this.stackFrames[i];
            if (frame.params === null) {
                continue;
            }
            if (frame.params.hasOwnProperty(paramName)) {
                return frame.params[paramName];
            }
        }
        return null;
    }

    /**
     * Whether the current execution of a thread is at the top of the stack.
     * @return {boolean} True if execution is at top of the stack.
     */
    atStackTop () {
        return this.peekStack() === this.topBlock;
    }


    /**
     * Switch the thread to the next block at the current level of the stack.
     * For example, this is used in a standard sequence of blocks,
     * where execution proceeds from one block to the next.
     */
    goToNextBlock () {
        const nextBlockId = this.blockContainer.getNextBlock(this.peekStack());
        this.reuseStackForNextBlock(nextBlockId);

        // this.stackPointer = this.stackPointer.next;
    }

    /**
     * Step a thread into a block's branch.
     * @param {!Thread} thread Thread object to step to branch.
     * @param {number} branchNum Which branch to step to (i.e., 1, 2).
     * @param {boolean} isLoop Whether this block is a loop.
     */
    stepToBranch (branchNum, isLoop) {
        if (!branchNum) {
            branchNum = 1;
        }
        const currentBlockId = this.peekStack();
        const branchId = this.blockContainer.getBranch(
            currentBlockId,
            branchNum
        );
        this.peekStackFrame().isLoop = isLoop;
        if (branchId) {
            // Push branch ID to the this's stack.
            this.pushStack(branchId);
        } else {
            this.pushStack(null);
        }
    }

    /**
     * Step a procedure.
     * @param {!Thread} thread Thread object to step to procedure.
     * @param {!string} procedureCode Procedure code of procedure to step to.
     */
    stepToProcedure (procedureCode) {
        const definition = this.blockContainer.getProcedureDefinition(procedureCode);
        if (!definition) {
            return;
        }
        // Check if the call is recursive.
        // If so, set the this to yield after pushing.
        const isRecursive = this.isRecursiveCall(procedureCode);
        // To step to a procedure, we put its definition on the stack.
        // Execution for the this will proceed through the definition hat
        // and on to the main definition of the procedure.
        // When that set of blocks finishes executing, it will be popped
        // from the stack by the sequencer, returning control to the caller.
        this.pushStack(definition);
        // In known warp-mode thiss, only yield when time is up.
        if (this.peekStackFrame().warpMode &&
            this.warpTimer.timeElapsed() > Sequencer.WARP_TIME) {
            this.status = Thread.STATUS_YIELD;
        } else {
            // Look for warp-mode flag on definition, and set the this
            // to warp-mode if needed.
            const definitionBlock = this.blockContainer.getBlock(definition);
            const innerBlock = this.blockContainer.getBlock(
                definitionBlock.inputs.custom_block.block);
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
                this.peekStackFrame().warpMode = true;
            } else if (isRecursive) {
                // In normal-mode thiss, yield any time we have a recursive call.
                this.status = Thread.STATUS_YIELD;
            }
        }
    }

    /**
     * Attempt to determine whether a procedure call is recursive,
     * by examining the stack.
     * @param {!string} procedureCode Procedure code of procedure being called.
     * @return {boolean} True if the call appears recursive.
     */
    isRecursiveCall (procedureCode) {
        let callCount = 5; // Max number of enclosing procedure calls to examine.
        const sp = this.stack.length - 1;
        for (let i = sp - 1; i >= 0; i--) {
            const block = this.blockContainer.getBlock(this.stack[i]);
            if (block.opcode === 'procedures_call' &&
                block.mutation.proccode === procedureCode) {
                return true;
            }
            if (--callCount < 0) return false;
        }
        return false;
    }
}

module.exports = Thread;
