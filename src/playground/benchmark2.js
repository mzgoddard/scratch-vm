class StatTable {
  render () {
    return h`${this.keys().map(key => this.viewOf(key))}`;
  }
}

const floor3 = time => (Math.floor(time * 1000) / 1000 / 1000).toPrecision(3);

class StatView {
  render ({isSlow}) {
    return h`<tr class="${isSlow(this) && 'slow'}">
      <td>${this.name}</td>
      <td>${floor3(this.selfTime)}</td>
      <td>${floor3(this.totalTime)}</td>
      <td>${this.executions}</td>
    </td>`;
  }
}

class RunningStatsView {
  render () {
    const {
      runningStats: {recordedTime, executed: {steps, blocks}},
      recordedTimeDom,
      stepsLoopedDom,
      blocksExecutedDom,
      maxWorkedTime
    } = this;
    const fractionWorked = recordedTime / maxWorkedTime;
    const fractionWorked100 = `${(fractionWorked * 100).toFixed(1)} %`;
    return h`<div class="profile-count">
      <label>Percent of time worked:</label>
      <spanclass="profile-count-value profile-count-amount-recorded">${fractionWorked100 || '...'}</span>
    </div>
    <div class="profile-count">
      <label>Steps looped:</label>
      <span class="profile-count-value profile-count-steps-looped">${steps || '...'}</span>
    </div>
    <div class="profile-count">
      <label>Blocks executed:</label>
      <span class="profile-count-value profile-count-blocks-executed">${blocks || '...'}</span>
    </div>`;
  }
}

class ProfilerRun {
  constructor () {
    attach(dom.querySelector(), new RunningStatsView({runningStats, maxRecordedTime}));
    attach(dom.querySelector(), new FramesTable({}));
    attach(dom.querySelector(), )
  }
}

