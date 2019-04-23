const Cast = require('../util/cast');
const execute = require('../engine/execute');
const Thread = require('../engine/thread');
const BlocksExecuteCache = require('../engine/blocks-execute-cache');

class Scratch3VMBlocks {
    constructor (runtime) {
        /**
         * The runtime instantiating this block package.
         * @type {Runtime}
         */
        this.runtime = runtime;
    }

    /**
     * Retrieve the block primitives implemented by this package.
     * @return {object.<string, Function>} Mapping of opcode to Function.
     */
    getPrimitives () {
        return {
            vm_end_of_thread: this.endOfThread,
            vm_end_of_procedure: this.endOfProcedure,
            vm_end_of_loop_branch: this.endOfLoopBranch,
            vm_end_of_branch: this.endOfBranch,
            vm_cast_string: this.castString,
            vm_reenter_promise: this.reenterFromPromise,
            vm_last_operation: this.lastOperation
        };
    }

    getHats () {
        return {
        };
    }

    endOfThread (args, {thread}) {
        thread.popStack();
        thread.status = Thread.STATUS_DONE;
    }

    endOfProcedure (args, {thread}) {
        thread.popStack();
        thread.goToNextBlock();

        if (thread.peekStackFrame().warpMode && !thread.warpTimer) {
            // Initialize warp-mode timer if it hasn't been already.
            // This will start counting the thread toward `Sequencer.WARP_TIME`.
            thread.warpTimer = new Timer();
            thread.warpTimer.start();
        }
    }

    endOfLoopBranch (args, {thread}) {
        thread.popStack();
        thread.status = Thread.STATUS_YIELD;
    }

    endOfBranch (args, {thread}) {
        thread.popStack();
        thread.goToNextBlock();
    }

    castString (args) {
        return Cast.toString(args.VALUE);
    }

    reenterFromPromise (args, {sequencer, thread}) {
        thread.popStack();

        // Current block to execute is the one on the top of the stack.
        const currentBlockId = thread.peekStack();
        const currentStackFrame = thread.peekStackFrame();

        let blockCached = (
            BlocksExecuteCache.getCached(thread.blockContainer, currentBlockId) ||
            BlocksExecuteCache.getCached(sequencer.blocks, currentBlockId) ||
            BlocksExecuteCache.getCached(sequencer.runtime.flyoutBlocks, currentBlockId)
        );
        if (blockCached === null) {
            // No block found: stop the thread; script no longer exists.
            sequencer.retireThread(thread);
            return;
        }

        const ops = blockCached._ops;
        const length = ops.length;
        let i = 0;

        const reported = thread.reported;
        // Reinstate all the previous values.
        for (; i < reported.length; i++) {
            const {opCached: oldOpCached, inputValue} = reported[i];

            const opCached = ops.find(op => op.id === oldOpCached);

            if (opCached) {
                const inputName = opCached._parentKey;
                const argValues = opCached._parentValues;
                argValues[inputName] = inputValue;
            }
        }

        // Find the last reported block that is still in the set of operations.
        // This way if the last operation was removed, we'll find the next
        // candidate. If an earlier block that was performed was removed then
        // we'll find the index where the last operation is now.
        if (reported.length > 0) {
            const lastExisting = reported.reverse().find(report => ops.find(op => op.id === report.opCached));
            if (lastExisting) {
                i = ops.findIndex(opCached => opCached.id === lastExisting.opCached) + 1;
            } else {
                i = 0;
            }
        }

        // The reporting block must exist and must be the next one in the sequence of operations.
        if (thread.justReported !== null && ops[i] && ops[i].id === thread.reporting) {
            const opCached = ops[i];
            const inputValue = thread.justReported;

            thread.justReported = null;

            const inputName = opCached._parentKey;
            const argValues = opCached._parentValues;
            argValues[inputName] = inputValue;
        }

        i += 1;

        thread.reporting = null;
        thread.reported = null;

        const allOps = ops;
        blockCached._ops = blockCached._ops.slice(i);

        const continuous = thread.continuous;
        thread.continuous = false;
        execute(sequencer, thread);
        thread.continuous = continuous;

        blockCached._ops = allOps;

        if (thread.reported) {
            thread.reported = reported.concat(thread.reported);
        }

        if (thread.status === Thread.STATUS_RUNNING && thread.peekStack() === currentBlockId) {
            thread.goToNextBlock();
        }
    }

    lastOperation (args, {sequencer, thread}) {
        // Current block to execute is the one on the top of the stack.
        const currentBlockId = thread.peekStack();
        const currentStackFrame = thread.peekStackFrame();

        let blockCached = (
            BlocksExecuteCache.getCached(thread.blockContainer, currentBlockId) ||
            BlocksExecuteCache.getCached(sequencer.blocks, currentBlockId) ||
            BlocksExecuteCache.getCached(sequencer.runtime.flyoutBlocks, currentBlockId)
        );
        if (blockCached === null) {
            // No block found: stop the thread; script no longer exists.
            sequencer.retireThread(thread);
            return;
        }

        const opcode = blockCached.opcode;
        const isHat = blockCached._isHat;

        const resolvedValue = args.VALUE;

        thread.pushReportedValue(resolvedValue);
        if (isHat) {
            // Hat predicate was evaluated.
            if (sequencer.runtime.getIsEdgeActivatedHat(opcode)) {
                // If this is an edge-activated hat, only proceed if the value is
                // true and used to be false, or the stack was activated explicitly
                // via stack click
                if (!thread.stackClick) {
                    const hasOldEdgeValue = thread.target.hasEdgeActivatedValue(currentBlockId);
                    const oldEdgeValue = thread.target.updateEdgeActivatedValue(
                        currentBlockId,
                        resolvedValue
                    );

                    const edgeWasActivated = hasOldEdgeValue ? (!oldEdgeValue && resolvedValue) : resolvedValue;
                    if (!edgeWasActivated) {
                        sequencer.retireThread(thread);
                    } else {
                        thread.goToNextBlock();
                    }
                } else {
                    thread.goToNextBlock();
                }
            } else if (!resolvedValue) {
                // Not an edge-activated hat: retire the thread
                // if predicate was false.
                sequencer.retireThread(thread);
            } else {
                thread.goToNextBlock();
            }
        } else {
            // In a non-hat, report the value visually if necessary if
            // at the top of the thread stack.
            if (lastOperation && typeof resolvedValue !== 'undefined' && thread.atStackTop()) {
                if (thread.stackClick) {
                    sequencer.runtime.visualReport(currentBlockId, resolvedValue);
                }
                if (thread.updateMonitor) {
                    const targetId = sequencer.runtime.monitorBlocks.getBlock(currentBlockId).targetId;
                    if (targetId && !sequencer.runtime.getTargetById(targetId)) {
                        // Target no longer exists
                        return;
                    }
                    sequencer.runtime.requestUpdateMonitor(Map({
                        id: currentBlockId,
                        spriteName: targetId ? sequencer.runtime.getTargetById(targetId).getName() : null,
                        value: resolvedValue
                    }));
                }
            }
            // Finished any yields.
            thread.status = Thread.STATUS_RUNNING;
        }
    }
}

module.exports = Scratch3VMBlocks;
