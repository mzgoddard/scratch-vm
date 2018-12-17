const Timer = require('../util/timer');
const Thread = require('./thread');
const execute = require('./execute.js');

/**
 * Profiler frame name for stepping a single thread.
 * @const {string}
 */
const stepThreadProfilerFrame = 'Sequencer.stepThread';

/**
 * Profiler frame name for the inner loop of stepThreads.
 * @const {string}
 */
const stepThreadsInnerProfilerFrame = 'Sequencer.stepThreads#inner';

/**
 * Profiler frame name for execute.
 * @const {string}
 */
const executeProfilerFrame = 'execute';

/**
 * Profiler frame ID for stepThreadProfilerFrame.
 * @type {number}
 */
let stepThreadProfilerId = -1;

/**
 * Profiler frame ID for stepThreadsInnerProfilerFrame.
 * @type {number}
 */
let stepThreadsInnerProfilerId = -1;

/**
 * Profiler frame ID for executeProfilerFrame.
 * @type {number}
 */
let executeProfilerId = -1;

class Sequencer {
    constructor (runtime) {
        /**
         * A utility timer for timing thread sequencing.
         * @type {!Timer}
         */
        this.timer = new Timer();

        /**
         * Reference to the runtime owning this sequencer.
         * @type {!Runtime}
         */
        this.runtime = runtime;
    }

    /**
     * Time to run a warp-mode thread, in ms.
     * @type {number}
     */
    static get WARP_TIME () {
        return 500;
    }

    /**
     * Step through all threads in `this.runtime.threads`, running them in order.
     * @return {Array.<!Thread>} List of inactive threads after stepping.
     */
    stepThreads () {
        // Work time is 75% of the thread stepping interval.
        const WORK_TIME = 0.75 * this.runtime.currentStepTime;
        // For compatibility with Scatch 2, update the millisecond clock
        // on the Runtime once per step (see Interpreter.as in Scratch 2
        // for original use of `currentMSecs`)
        this.runtime.updateCurrentMSecs();
        // Start counting toward WORK_TIME.
        this.timer.start();
        // Count of active threads.
        let numActiveThreads = Infinity;
        // Whether `stepThreads` has run through a full single tick.
        let ranFirstTick = false;
        const doneThreads = [];
        // Conditions for continuing to stepping threads:
        // 1. We must have threads in the list, and some must be active.
        // 2. Time elapsed must be less than WORK_TIME.
        // 3. Either turbo mode, or no redraw has been requested by a primitive.
        while (this.runtime.threads.length > 0 &&
               numActiveThreads > 0 &&
               this.timer.timeElapsed() < WORK_TIME &&
               (this.runtime.turboMode || !this.runtime.redrawRequested)) {
            if (this.runtime.profiler !== null) {
                if (stepThreadsInnerProfilerId === -1) {
                    stepThreadsInnerProfilerId = this.runtime.profiler.idByName(stepThreadsInnerProfilerFrame);
                }
                this.runtime.profiler.start(stepThreadsInnerProfilerId);
            }

            numActiveThreads = 0;
            let stoppedThread = false;
            // Attempt to run each thread one time.
            for (let i = 0; i < this.runtime.threads.length; i++) {
                const activeThread = this.runtime.threads[i];
                // Check if the thread is done so it is not executed.
                if (activeThread.stackPointers.length === 0 ||
                    activeThread.status === Thread.STATUS_DONE) {
                    // Finished with this thread.
                    stoppedThread = true;
                    continue;
                }
                if (activeThread.status === Thread.STATUS_YIELD_TICK &&
                    !ranFirstTick) {
                    // Clear single-tick yield from the last call of `stepThreads`.
                    activeThread.status = Thread.STATUS_RUNNING;
                }
                if (activeThread.status === Thread.STATUS_RUNNING ||
                    activeThread.status === Thread.STATUS_YIELD) {
                    // Normal-mode thread: step.
                    if (this.runtime.profiler !== null) {
                        if (stepThreadProfilerId === -1) {
                            stepThreadProfilerId = this.runtime.profiler.idByName(stepThreadProfilerFrame);
                        }
                        this.runtime.profiler.start(stepThreadProfilerId);
                    }
                    this.stepThread(activeThread);
                    if (this.runtime.profiler !== null) {
                        this.runtime.profiler.stop();
                    }
                    activeThread.warpTimer = null;
                    if (activeThread.isKilled) {
                        i--; // if the thread is removed from the list (killed), do not increase index
                    }
                }
                if (activeThread.status === Thread.STATUS_RUNNING) {
                    numActiveThreads++;
                }
                // Check if the thread completed while it just stepped to make
                // sure we remove it before the next iteration of all threads.
                if (activeThread.stackPointers.length === 0 ||
                    activeThread.status === Thread.STATUS_DONE) {
                    // Finished with this thread.
                    stoppedThread = true;
                    this.runtime.updateCurrentMSecs();
                }
            }
            // We successfully ticked once. Prevents running STATUS_YIELD_TICK
            // threads on the next tick.
            ranFirstTick = true;

            if (this.runtime.profiler !== null) {
                this.runtime.profiler.stop();
            }

            // Filter inactive threads from `this.runtime.threads`.
            if (stoppedThread) {
                let nextActiveThread = 0;
                for (let i = 0; i < this.runtime.threads.length; i++) {
                    const thread = this.runtime.threads[i];
                    if (thread.stackPointers.length !== 0 &&
                        thread.status !== Thread.STATUS_DONE) {
                        this.runtime.threads[nextActiveThread] = thread;
                        nextActiveThread++;
                    } else {
                        doneThreads.push(thread);
                    }
                }
                this.runtime.threads.length = nextActiveThread;
            }
        }

        // console.log(this.runtime.threads.length, doneThreads.length);

        return doneThreads;
    }

    /**
     * Step the requested thread for as long as necessary.
     * @param {!Thread} thread Thread object to step.
     */
    stepThread (thread) {
        if (thread.target === null) {
            this.retireThread(thread);
            return;
        }

        // Save the current block ID to notice if we did control flow.
        let currentBlockPointer = thread.lastStackPointer;
        let stackFrame = thread.peekStackFrame();

        if (stackFrame.warpMode) {
            // Initialize warp-mode timer. This will start counting the thread
            // toward `Sequencer.WARP_TIME`.
            thread.warpTimer = new Timer();
            thread.warpTimer.start();
        }

        while (currentBlockPointer !== null) {
            // !this.runtime._hats[currentBlockPointer.getBlock().opcode] && !currentBlockPointer.getBlock().isMonitored && console.log(currentBlockPointer.getBlock().opcode, currentBlockPointer.getBlock());
            // Execute the current block.
            if (this.runtime.profiler !== null) {
                if (executeProfilerId === -1) {
                    executeProfilerId = this.runtime.profiler.idByName(executeProfilerFrame);
                }
                // The method commented below has its code inlined underneath to
                // reduce the bias recorded for the profiler's calls in this
                // time sensitive stepThread method.
                //
                // this.runtime.profiler.start(executeProfilerId, null);
                this.runtime.profiler.records.push(
                    this.runtime.profiler.START, executeProfilerId, null, 0);
            }

            execute(this, thread);

            if (this.runtime.profiler !== null) {
                // this.runtime.profiler.stop();
                this.runtime.profiler.records.push(this.runtime.profiler.STOP, 0);
            }

            thread.blockGlowInFrame = currentBlockPointer.blockId;

            // Blocks should glow when a script is starting,
            // not after it has finished (see #1404).
            // Only blocks in blockContainers that don't forceNoGlow
            // should request a glow.
            if (!thread.blockContainer.forceNoGlow) {
                thread.requestScriptGlowInFrame = true;
            }

            if (thread.status !== Thread.STATUS_RUNNING) {
                // If the thread has yielded or is waiting, yield to other
                // threads.
                if (thread.status === Thread.STATUS_YIELD) {
                    // Mark as running for next iteration.
                    thread.status = Thread.STATUS_RUNNING;

                    // In warp mode, yielded blocks are re-executed immediately.
                    if (
                        stackFrame.warpMode &&
                        thread.warpTimer.timeElapsed() <= Sequencer.WARP_TIME
                    ) {
                        continue;
                    }
                }

                // } else if (thread.status === Thread.STATUS_PROMISE_WAIT) {
                //
                // A promise was returned by the primitive. Yield the thread
                // until the promise resolves. Promise resolution should reset
                // thread.status to Thread.STATUS_RUNNING.

                // } else if (thread.status === Thread.STATUS_YIELD_TICK) {
                //
                // stepThreads will reset the thread to Thread.STATUS_RUNNING
                return;
            }

            const next = thread.lastStackPointer;
            if (next === currentBlockPointer || !stackFrame.isLoop && next === null) {
                // No control flow has happened or a non-loop control flow into
                // an empty branch has happened.
                currentBlockPointer = currentBlockPointer.stepThread(thread);
                stackFrame = thread.peekStackFrame();

                if (stackFrame !== null &&
                    stackFrame.isLoop &&
                    (!stackFrame.warpMode ||
                    thread.warpTimer.timeElapsed() > Sequencer.WARP_TIME)
                ) {
                    return;
                    // Don't do anything to the stack, since loops
                    // need to be re-executed.
                    if (
                        !stackFrame.warpMode ||
                        thread.warpTimer.timeElapsed() > Sequencer.WARP_TIME
                    ) {
                        // Re-execute the loop in the future.
                        return;
                    }
                    // Get currentBlockId block of existing block on the
                    // stack.
                    currentBlockPointer = thread.lastStackPointer;
                    break;
                }

                // currentBlockPointer = currentBlockPointer.getNext();
                //
                // if (currentBlockPointer !== null) {
                //     // We found a block to move to. Move the thread to that
                //     // block and execute it.
                //     thread.reuseStackForNextBlock();
                //     continue;
                // }
                //
                // // thread.nextBlock();
                // // currentBlockId = thread.peekStack();
                // // stackFrame = thread.peekStackFrame();
                //
                // // The end of a C-block or stack has been reached. Pop until
                // // we hit a loop or can increment to a block.
                // while (true) {
                //     thread.popStack();
                //
                //     stackFrame = thread.peekStackFrame();
                //     if (stackFrame === null) {
                //         // The end of the entire stack has been reached.
                //         // Return from stepThread and let stepThreads clean
                //         // it up.
                //         return;
                //     }
                //
                //     if (stackFrame.isLoop) {
                //         // Don't do anything to the stack, since loops
                //         // need to be re-executed.
                //         if (
                //             !stackFrame.warpMode ||
                //             thread.warpTimer.timeElapsed() > Sequencer.WARP_TIME
                //         ) {
                //             // Re-execute the loop in the future.
                //             return;
                //         }
                //         // Get currentBlockId block of existing block on the
                //         // stack.
                //         currentBlockPointer = thread.lastStackPointer;
                //         break;
                //     }
                //
                //     // Get currentBlockId block of existing block on the
                //     // stack.
                //     currentBlockPointer = thread.lastStackPointer.getNext();
                //
                //     if (currentBlockPointer !== null) {
                //         // We found a block to move to. Move the thread to
                //         // that block and execute it.
                //         thread.reuseStackForNextBlock();
                //         break;
                //     }
                // }
            } else if (next !== null) {
                // Control flow has happened.
                currentBlockPointer = next;
                stackFrame = thread.peekStackFrame();
                thread.shouldPushExecutionContext = true;

                // We only need to initialize the warpTimer at the beginning
                // of stepThread and when control flow has happened.
                if (stackFrame.warpMode && !thread.warpTimer) {
                    // Initialize warp-mode timer if it hasn't been already.
                    // This will start counting the thread toward
                    // `Sequencer.WARP_TIME`.
                    thread.warpTimer = new Timer();
                    thread.warpTimer.start();
                }
            } else {
                // Control flow has happened. An empty branch or procedure was
                // pushed.
                thread.popStack();
                if (
                    stackFrame.warpMode &&
                    thread.warpTimer.timeElapsed() > Sequencer.WARP_TIME
                ) {
                    return;
                }
            }

            // If no next block has been found at this point, look on the stack.
            // // let stepToNextBlock = true;
            // while (true) {
            //     thread.popStack();
            //
            //     stackFrame = thread.peekStackFrame();
            //
            //     if (stackFrame === null) {
            //         return;
            //     }
            //
            //     currentBlockId = thread.peekStack();
            //
            //     if (!stackFrame.isLoop) {
            //         currentBlockId = thread.target.blocks.getNextBlock(currentBlockId);
            //
            //         if (currentBlockId !== null) {
            //             thread.reuseStackForNextBlock(currentBlockId);
            //             stackFrame = thread.peekStackFrame();
            //             break;
            //         }
            //     } else if (
            //         !stackFrame.warpMode ||
            //         thread.warpTimer.timeElapsed() > Sequencer.WARP_TIME
            //     ) {
            //         return;
            //     } else {
            //         break;
            //     }
            // }

            //     if (thread.stack.length === 0) {
            //         // No more stack to run!
            //         thread.status = Thread.STATUS_DONE;
            //         return;
            //     }
            //
            //     stackFrame = thread.peekStackFrame();
            //     currentBlockId = thread.peekStack();
            //
            //     if (stackFrame.isLoop) {
            //         // The current level of the stack is marked as a loop.
            //         // Return to yield for the frame/tick in general.
            //         // Unless we're in warp mode - then only return if the
            //         // warp timer is up.
            //         if (!stackFrame.warpMode ||
            //             thread.warpTimer.timeElapsed() > Sequencer.WARP_TIME) {
            //             // Don't do anything to the stack, since loops need
            //             // to be re-executed.
            //             return;
            //         }
            //         // Don't go to the next block for this level of the stack,
            //         // since loops need to be re-executed.
            //         stepToNextBlock = false;
            //         break;
            //     }
            //
            //     // Get currentBlockId block of existing block on the stack.
            //     currentBlockId = thread.target.blocks.getNextBlock(currentBlockId);
            //
            //     if (currentBlockId !== null) {
            //         thread.reuseStackForNextBlock(currentBlockId);
            //         stackFrame = thread.peekStackFrame();
            //         break;
            //     }
            // } while (currentBlockId === null);
            //
            // if (stepToNextBlock) {
            //     thread.reuseStackForNextBlock(currentBlockId);
            //     stackFrame = thread.peekStackFrame();
            // }
        }
    }

    /**
     * Step a thread into a block's branch.
     * @param {!Thread} thread Thread object to step to branch.
     * @param {number} branchNum Which branch to step to (i.e., 1, 2).
     * @param {boolean} isLoop Whether this block is a loop.
     */
    stepToBranch (thread, branchNum, isLoop) {
        if (!branchNum) {
            branchNum = 1;
        }
        const currentBlockPointer = thread.lastStackPointer;
        const branchPointer = currentBlockPointer.getBranch(branchNum);
        thread.peekStackFrame().isLoop = isLoop;
        thread.lastStackPointer.isLoop = isLoop;
        if (branchPointer) {
            // Push branch ID to the thread's stack.
            thread.pushStack(null, branchPointer);
        } else {
            thread.pushStack(null, null);
        }
    }

    /**
     * Step a procedure.
     * @param {!Thread} thread Thread object to step to procedure.
     * @param {!string} procedureCode Procedure code of procedure to step to.
     */
    stepToProcedure (thread, procedureCode) {
        const blockPointer = thread.lastStackPointer;
        const definitionPointer = blockPointer.getProcedureDefinition();
        // const definition = thread.target.blocks.getProcedureDefinition(procedureCode);
        if (!definitionPointer) {
            return;
        }
        // Check if the call is recursive.
        // If so, set the thread to yield after pushing.
        const isRecursive = thread.isRecursiveCall(procedureCode);
        // To step to a procedure, we put its definition on the stack.
        // Execution for the thread will proceed through the definition hat
        // and on to the main definition of the procedure.
        // When that set of blocks finishes executing, it will be popped
        // from the stack by the sequencer, returning control to the caller.
        if (!thread.lastStackPointer.stepThreadInitialized) {
            thread.lastStackPointer.setStepThread(thread.lastStackPointer.STEP_THREAD_METHOD.POP_PARAMS);
        }
        thread.pushStack(null, definitionPointer);
        // In known warp-mode threads, only yield when time is up.
        if (thread.peekStackFrame().warpMode &&
            thread.warpTimer.timeElapsed() > Sequencer.WARP_TIME) {
            thread.status = Thread.STATUS_YIELD;
        } else {
            // Look for warp-mode flag on definition, and set the thread
            // to warp-mode if needed.
            // const definitionBlock = thread.target.blocks.getBlock(definition);
            const innerBlock = blockPointer.getProcedureInnerBlock();
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
                thread.peekStackFrame().warpMode = true;
            } else if (isRecursive) {
                // In normal-mode threads, yield any time we have a recursive call.
                thread.status = Thread.STATUS_YIELD;
            }
        }
    }

    /**
     * Retire a thread in the middle, without considering further blocks.
     * @param {!Thread} thread Thread object to retire.
     */
    retireThread (thread) {
        thread.stack = [];
        thread.stackFrames = [];
        thread.requestScriptGlowInFrame = false;
        thread.status = Thread.STATUS_DONE;
    }
}

module.exports = Sequencer;
