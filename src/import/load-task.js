const regeneratorRuntime = require('regenerator-runtime');

class LoadTask {
    async run () {}

    withConfig () {}

    assume () {}
}

LoadTask.taskify = function (maybeTask) {
    if (maybeTask instanceof LoadTask) {
        return maybeTask;
    } else if (typeof maybeTask === 'function') {
        return new LoadTask.Function(maybeTask);
    }
};

LoadTask.Function = class LoadTaskFunction extends LoadTask {
    constructor (func) {
        super();

        this.func = func;
    }

    async run (mediator, options) {
        return await this.func(mediator, options);
    }

    withConfig () {
        return this;
    }
};

LoadTask.GeneratedFunction = class LoadTaskGeneratedFunction extends LoadTask.Function {
    constructor (func, config) {
        super(func(config));

        this.generator = func;
        this.configuration = config;
    }

    withConfig (config = this.configuration) {
        return new LoadTask.GeneratedFunction(this.generator, config);
    }
};

LoadTask.DerefScope = class LoadTaskDerefScope extends LoadTask {
    constructor (key, subtask) {
        super();

        this.key = key;
        this.subtask = subtask;
    }

    async run (scope, options) {
        return await this.subtask.run(scope[this.key], options);
    }
};

LoadTask.Branch = class LoadTaskBranch extends LoadTask {
    constructor (test, ifTrue, ifFalse) {
        super();

        this.test = test;
        this.ifTrue = ifTrue;
        this.ifFalse = ifFalse;
    }

    async run (mediator, options) {
        if (await this.test.run(mediator, options)) {
            await (this.ifTrue && this.ifTrue.run(mediator, options));
        } else {
            await (this.ifFalse && this.ifFalse.run(mediator, options));
        }
    }

    withConfig (config) {
        return new LoadTask.Branch(
            this.test.withConfig(config),
            this.ifTrue.withConfig(config),
            this.ifFalse.withConfig(config)
        );
    }

    assume (mediator, options) {
        const result = this.test.run(mediator, options);
        if (result === true) {
            return this.ifTrue;
        } else if (result === false) {
            return this.ifFalse;
        }
        return this;
    }
};

LoadTask.Sequence = class LoadTaskSequence extends LoadTask {
    constructor (tasks) {
        super();

        this.tasks = tasks.map(LoadTask.taskify);
    }

    async run (mediator, options) {
        for (const task of this.tasks) {
            await task.run(mediator, options);
        }
    }

    withConfig (config) {
        return new LoadTask.Sequence(this.tasks.map(task => task.withConfig(config)));
    }
};

LoadTask.Parallel = class LoadTaskParallel extends LoadTask {
    constructor (tasks) {
        super();

        this.tasks = tasks.map(LoadTask.taskify);
    }

    async run (mediator, options) {
        await Promise.all(this.tasks.map(task => task.run(mediator, options)));
    }

    withConfig (config) {
        return new LoadTask.Sequence(this.tasks.map(task => task.withConfig(config)));
    }
};

module.exports = LoadTask;
