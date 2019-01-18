const columnTitles = [
    'Platform',
    'Project ID',
    'Warm Up',
    'Recording',
    'develop',
    'after change',
    'difference'
];

class Preview {
    constructor () {
        this.selectAll = this.selectAll.bind(this);
    }

    selectAll (ev) {
        ev.preventDefault();
        const range = document.createRange();
        range.selectNodeContents(ev.target.parentElement.querySelector('code'));
        window.getSelection().empty();
        window.getSelection().addRange(range);
        document.execCommand('copy');
        return false;
    }
}

class MarkdownPreview extends Preview {
    constructor (rows) {
        super();
        this.rows = rows;
    }

    render () {
        return lemn.h`<section><h2 id="markdown">Markdown Table</h2><a href="?" onclick="${this.selectAll}">Copy Table</a><pre><code>${
            columnTitles.join(' | ') + '\n'
        }${
            columnTitles.map((title, i) => title.replace(/./g, '-').substring(0, title.length - 1) + (i > 3 ? ':' : '-')).join(' | ') + '\n'
        }${this.rows.as(groups => (
            groups.map(rows => rows.map(row => row.join(' | ')).join('\n')).join('\n'))
        )}</code></pre></section>`;
    }
}

class CsvPreview extends Preview {
    constructor (rows) {
        super();
        this.rows = rows;
    }

    render () {
        return lemn.h`<section><h2 id="csv">CSV Table</h2><a href="?" onclick="${this.selectAll}">Copy Table</a><pre><code>${this.rows.as(groups => (
            groups.map(rows => rows.map(row => row.join(', ')).join('\n')).join('\n'))
        )}</code></pre></section>`;
    }
}

function loadReport (file) {

}

class App {
    constructor () {
        this.data = new lemn.Model([]);
        this.files = new lemn.Model(undefined);

        const rows = this.data.as(
            reports => {
                const firstReport = reports.filter(report => /develop/.test(report.name))[0];
                if (!firstReport) {return [];}

                const subname = /-(.*)\.json$/.exec(firstReport.name)[1];

                return [...firstReport.results.map(
                    firstResult => {
                        return reports.filter(report => /develop/.test(report.name)).map(
                            report => [report, report.results.find(result => result.fixture.projectId === firstResult.fixture.projectId && result.fixture.warmUpTime === firstResult.fixture.warmUpTime && result.fixture.recordingTime === firstResult.fixture.recordingTime)]
                        ).map(([report, result]) => {
                            const blockFunctionFrame = result.frames.find(frame => frame.name === 'blockFunction');
                            const stepFrame = result.frames.find(frame => frame.name === 'Sequencer.stepThreads#inner');
                            const platformName = /^([^-]+)/.exec(report.name)[1];
                            const improvedReport = reports.filter(report => !/develop/.test(report.name)).find(improved => improved.name.includes(platformName));
                            const improvedResult = improvedReport && improvedReport.results.find(improved => improved.fixture.projectId === result.fixture.projectId && improved.fixture.warmUpTime === result.fixture.warmUpTime && improved.fixture.recordingTime === result.fixture.recordingTime);
                            const improvedBlockFunctionFrame = improvedResult ? improvedResult.frames.find(frame => frame.name === 'blockFunction') : {executions: 0};
                            const improvedStepFrame = improvedResult ? improvedResult.frames.find(frame => frame.name === 'Sequencer.stepThreads#inner') : {totalTime: 0};

                            const baseBPS = blockFunctionFrame.executions /
                                stepFrame.totalTime * 1000;
                            const improvedBPS = improvedBlockFunctionFrame.executions /
                                improvedStepFrame.totalTime * 1000;

                            const change = improvedBPS / baseBPS * 100 - 100;

                            return [
                                platformName,
                                result.fixture.projectId,
                                result.fixture.warmUpTime,
                                result.fixture.recordingTime,
                                Math.floor(baseBPS),
                                // improvedReport && `${improvedReport.name},${JSON.stringify(improvedResult.fixture)},${JSON.stringify(improvedBlockFunctionFrame)},${JSON.stringify(improvedStepFrame)},${Math.floor(improvedBPS)}`,
                                Math.floor(improvedBPS),
                                (change >= 0 ? '+' : '') + change.toFixed(1)
                            ];
                        });
                    }
                )];
            }
        );

        const csv = rows.as(
            reports => reports.map(report => report.map(result => result.join(', ')).join('\n')).join('\n')
        );

        this.charts = {
            csv,
            rows
        };

        this.onDragOver = this.onDragOver.bind(this);
        this.onDrop = this.onDrop.bind(this);
        this.onChange = this.onChange.bind(this);
    }

    loadReport (file) {
        const reader = new FileReader();
        reader.onload = event => {
            const text = event.target.result;
            const json = JSON.parse(text);

            this.data.set(this.data.data.concat(Object.assign({name: file.name}, json)));
        };
        reader.readAsText(file);
    }

    onDragOver (ev) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
    }

    onDrop (ev) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
        try {
            Array.from(ev.dataTransfer.files).forEach(this.loadReport, this);
        } catch (error) {
            console.error(error);
        }
    }

    onChange (ev) {
        Array.from(ev.files).forEach(this.loadReport, this);
    }

    render () {
        return lemn.h`<div class="app" ondragover="${this.onDragOver}" ondrop="${this.onDrop}">
            <h2>Scratch VM Benchmark Table Generator</h2>
            <input type="file" class="drag-drop-input" onchange="${this.onChange}" hidden />
            <div><a href="#csv">CSV</a> | <a href="#markdown">Markdown</a></div>
            ${new CsvPreview(this.charts.rows)}
            <div><a href="#csv">CSV</a> | <a href="#markdown">Markdown</a></div>
            ${new MarkdownPreview(this.charts.rows)}
            <div><a href="#csv">CSV</a> | <a href="#markdown">Markdown</a></div>
        </div>`;
    }
}

Array.from(document.querySelectorAll('body > *')).forEach(el => el.parentNode.removeChild(el));
lemn.attach(document.querySelector('body'), new App);
