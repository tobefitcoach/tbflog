// ==========================================================================
// ATHLETE DETAIL - markup
// The loading skeleton and the full screen markup (tab bar, 4 tab panels and
// every modal), painted by mount() in index.js.
// ==========================================================================

// Shown for however long the initial athlete-row fetch takes - same
// "skeleton, not a blank screen" convention as athletes.js/trainings.js.
// Carries its own back button so leaving is possible even before the real
// TEMPLATE (and its own back button) has painted.
export const SKELETON = `
  <div class="screen-header">
    <button class="btn-back" id="athleteDetailBackBtn" aria-label="Back"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg></button>
    <h2 class="screen-title">Athlete</h2>
  </div>
  <div class="skeleton-bar" style="width:40%; height:26px; margin-bottom:24px"></div>
  <div class="skeleton-bar" style="height:64px; margin-bottom:12px"></div>
  <div class="skeleton-bar" style="height:64px; margin-bottom:12px"></div>
  <div class="skeleton-bar" style="height:64px"></div>
`

// Pre-extracted from athlete.html: the .profile block (tab bar + 4
// tab-panels) followed by every modal (Metrics tab's own modals, then the
// Calendar tab's - see athlete-calendar.js's own banner comment on why that
// file's modals live in athlete.html rather than being built by JS). The
// Calendar tab's own DAY CONTENT (toolbar/grid) is included since it was
// already static markup in athlete.html even though athlete-calendar.js
// fills the grid's cells in on first activation - only the grid's cells
// themselves are injected by JS, same as before.
//
// Changes made to the extracted markup itself:
//   - a screen-header + back button prepended (see the banner above)
//   - data-modal-dismiss added to one close/cancel control per modal (the
//     footer Cancel/Close when a modal has both a header ✕ and a footer
//     button, matching athletes.js's convention), so nav.js's hardware-back
//     handling (closeTopModal) can close the active modal properly instead
//     of falling back to a blunt force-close that skips that button's own
//     reset logic
//   - every id= checked for uniqueness now that both originals' markup
//     shares one root - none were found colliding (see the report)
export const TEMPLATE = `
  <div class="screen-header">
    <button class="btn-back" id="athleteDetailBackBtn" aria-label="Back"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg></button>
    <h2 class="screen-title" id="athleteDetailScreenTitle">Athlete</h2>
  </div>

    <div class="profile">

      <!-- Tab bar: switches which panel below is visible (see bindTabs()).
           Calendar tab content is filled in by activateCalendarTab() on
           first activation. -->
      <div class="tab-bar">
        <button class="tab-btn active" data-tab="overview">Overview</button>
        <button class="tab-btn" data-tab="metrics">Metrics</button>
        <button class="tab-btn" data-tab="calendar">Calendar</button>
        <button class="tab-btn" data-tab="settings">Settings</button>
      </div>

      <div class="tab-panel active" id="tab-overview">
      <!-- Profile header card: avatar, name/details, edit/log-weight buttons,
           freeform notes in the middle, and the bodyweight mini-graph on the right -->
      <div class="profile-header">
        <div class="profile-left">
          <div class="profile-initials" id="profileInitials"></div>
          <div class="profile-info">
            <div class="row-10-center">
              <h2 id="profileName"></h2>
              <span class="athlete-status-badge" id="profileStatusBadge"></span>
            </div>
            <p id="profileDetails"></p>
            <div class="profile-btns">
              <button class="btn-profile-action" id="editAthleteBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-inline-icon"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>Edit info</button>
              <button class="btn-profile-action" id="addBodyweightBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-inline-icon"><line x1="12" y1="3" x2="12" y2="21"></line><path d="M5 7l-3 7a4 4 0 0 0 8 0z"></path><path d="M19 7l-3 7a4 4 0 0 0 8 0z"></path><path d="M5 7h14"></path><path d="M12 3l4 4M12 3l-4 4"></path></svg>Log weight</button>
            </div>
          </div>
        </div>
        <!-- Athlete Notes: dated notes log (injury history, coaching cues,
             general observations). Each "Add" creates a new athlete_notes
             row instead of overwriting, so past notes stay visible with the
             date they were written -->
        <div class="profile-notes">
          <div class="row-between">
            <p class="bodyweight-label">Notes</p>
            <div class="row-8-center">
              <button class="unit-btn" id="viewNotesBtn">View all</button>
              <button class="btn-save-notes" id="addNoteBtn">+ Add</button>
            </div>
          </div>
          <div class="latest-note-preview no-notes" id="latestNotePreview">
            <p class="no-bodyweight-data">No notes yet</p>
          </div>
        </div>
        <div class="profile-right">
          <div class="row-between">
            <p class="bodyweight-label">Bodyweight</p>
            <div class="row-8-center">
              <button class="unit-btn" id="viewBWEntriesBtn">All entries</button>
              <div class="unit-toggle">
                <button class="unit-btn active" id="bwKgBtn">kg</button>
                <button class="unit-btn" id="bwLbsBtn">lbs</button>
              </div>
            </div>
          </div>
          <div class="bodyweight-graph-area">
            <canvas id="bodyweightGraph"></canvas>
            <p class="no-bodyweight-data" id="noBodyweightMsg">No weight entries yet</p>
          </div>
        </div>
      </div>

      <!-- Manual refresh + freshness indicator - this tab has no live
           updates otherwise, so a coach checking on an athlete's in-progress
           workout needs a way to know these numbers are current. Also
           auto-refreshes on tab focus, see the visibilitychange listener
           wired in mount() -->
      <div class="row-between">
        <span id="overviewUpdatedLabel" class="text-muted-sm"></span>
        <button class="unit-btn" id="refreshOverviewBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-inline-icon"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>Refresh</button>
      </div>

      <!-- Training stats + Recent Activity share the row 50/50 on desktop
           (Recent Activity used to be its own full-width block, which was
           more space than it needed), stacking on mobile - see
           .overview-top-split in css/athlete-detail.css -->
      <div class="overview-top-split">
        <!-- Training stats: how much of what was programmed actually got
             done, and how much volume they're moving - computed from the
             athlete's logged exercise_log_sets, see loadOverviewStats() -->
        <div class="stats-bar" id="overviewStatsBar">
          <div class="stat-item stat-item-clickable" id="statCompletionCard">
            <span class="stat-value" id="statCompletion">—</span>
            <span class="stat-label">Completion (30d)</span>
          </div>
          <div class="stat-item stat-item-clickable" id="statVolumeCard">
            <span class="stat-value" id="statVolume">—</span>
            <span class="stat-label">Volume (7d)</span>
          </div>
          <div class="stat-item stat-item-clickable" id="statDurationCard">
            <span class="stat-value" id="statDuration">—</span>
            <span class="stat-label">Avg Duration (30d)</span>
          </div>
        </div>

        <!-- Recent activity: last 5 things this athlete has done, merged
             from tournaments/own workouts/completed sessions - see
             loadRecentActivity() -->
        <div>
          <h3 class="detail-group-title" style="margin-top:0">Recent Activity</h3>
          <div id="recentActivityList"></div>
        </div>
      </div>

      <!-- Training load: how hard this athlete's training has actually
           been, from their own post-workout effort ratings - not just what
           got programmed. See the Training Load calc in loadOverviewStats() -->
      <h3 class="detail-group-title" style="margin-top:24px">Training Load</h3>
      <p style="color:#aaaacc; font-size:13px; margin-bottom:16px">How hard this athlete's training has been, from their own effort ratings - not just what got programmed.</p>
      <div class="stats-bar" id="loadStatsBar">
        <div class="stat-item stat-item-clickable" id="statWeeklyLoadCard">
          <span class="stat-value" id="statWeeklyLoad">—</span>
          <span class="stat-label">Weekly Load (7d)</span>
        </div>
        <div class="stat-item stat-item-clickable" id="statAcwrCard">
          <span class="stat-value" id="statAcwr">—</span>
          <span class="stat-label">ACWR</span>
          <span class="stat-risk-badge" id="statAcwrRisk" style="display:none"></span>
        </div>
        <div class="stat-item stat-item-clickable" id="statMonotonyCard">
          <span class="stat-value" id="statMonotony">—</span>
          <span class="stat-label">Monotony</span>
        </div>
        <div class="stat-item stat-item-clickable" id="statStrainCard">
          <span class="stat-value" id="statStrain">—</span>
          <span class="stat-label">Strain</span>
        </div>
      </div>

      <!-- Pain/injury reports: filled in by renderPainReports(), from the
           same 90-day sessions fetch loadOverviewStats already does. Hidden
           entirely when there's nothing unreviewed - this is the inbox;
           "Mark Reviewed" here is the only place these get acknowledged
           (Calendar day detail shows the same flag read-only, for context
           when browsing history). -->
      <div id="painReportsSection" style="display:none; margin-top:24px">
        <h3 class="detail-group-title" style="color:#ff6b6b"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg> Pain / Injury Reports</h3>
        <div id="painReportsList"></div>
      </div>

      </div>

      <div class="tab-panel" id="tab-metrics">
      <!-- PDF progress report - opens the Report Builder modal (checklist +
           time period), see openReportBuilderModal() -->
      <div style="display:flex; justify-content:flex-end; margin-bottom:12px">
        <button class="btn-add" id="generateReportBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-inline-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>Generate Report</button>
      </div>

      <!-- Summary stats row: metrics tracked, total entries, last updated, PRs this month -->
      <div class="stats-bar" id="statsBar">
        <div class="stat-item stat-item-clickable" id="statMetricsCard">
          <span class="stat-value" id="statMetrics">—</span>
          <span class="stat-label">Metrics tracked</span>
        </div>
        <div class="stat-item stat-item-clickable" id="statEntriesCard">
          <span class="stat-value" id="statEntries">—</span>
          <span class="stat-label">Total entries</span>
        </div>
        <div class="stat-item stat-item-clickable" id="statLastUpdatedCard">
          <span class="stat-value" id="statLastUpdated">—</span>
          <span class="stat-label">Last updated</span>
        </div>
        <div class="stat-item stat-item-clickable" id="statPRsCard">
          <span class="stat-value" id="statPRs">—</span>
          <span class="stat-label">PRs (last 30 days)</span>
        </div>
      </div>

      <!-- Tracked metrics grid (filled in by JS) + "Add Metric" button -->
      <div class="metrics-section">
        <div class="metrics-header">
          <h3>Tracked Metrics</h3>
          <button class="btn-add" id="addMetricBtn">+ Add Metric</button>
        </div>
       <div id="metricsList"></div>
      </div>
      </div>

      <div class="tab-panel" id="tab-calendar">
        <!-- Filled in by activateCalendarTab() / loadCalendarMonth() on
             first activation -->
        <!-- Shown while a Copy Week/Copy Workout is "armed" (see
             wireCalendarCopyArming) - the calendar itself is the target
             picker at that point, this bar just shows what's being copied
             and offers a way out -->
        <div class="copy-armed-bar" id="copyArmedBar">
          <span id="copyArmedBarText"></span>
          <button type="button" class="unit-btn" id="copyArmedCancelBtn">Cancel</button>
        </div>
        <div class="calendar-toolbar">
          <button class="icon-btn" id="calPrevBtn" aria-label="Previous month"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg></button>
          <h3 id="calMonthLabel">&nbsp;</h3>
          <button class="icon-btn" id="calNextBtn" aria-label="Next month"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg></button>
        </div>
        <!-- Static - the grid below always starts each row on Monday (see
             renderCalendarGrid's startWeekday math), so this never needs to
             be regenerated per month. Leading empty span lines the header up
             with the copy-icon gutter column #calendarGrid gets in JS (see
             the #calendarWeekdayHeader/#calendarGrid grid-template-columns
             overrides in css/coach-core.css). -->
        <div class="calendar-weekday-header" id="calendarWeekdayHeader">
          <span></span>
          <span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span>
        </div>
        <div id="calendarGridWrap" style="position:relative">
          <div class="calendar-grid" id="calendarGrid"></div>
          <div class="copy-drop-label" id="copyDropLabel"></div>
        </div>
      </div>

      <!-- Per-athlete settings, separate from Edit Info since these are
           configured once during onboarding rather than edited regularly -->
      <div class="tab-panel" id="tab-settings">
        <h3 class="detail-group-title" style="margin-bottom:4px">Athlete Settings</h3>
        <p style="color:#aaaacc; font-size:13px; margin-bottom:20px">Set these up once when onboarding this athlete.</p>

        <h4 class="settings-group-title" style="margin-top:0">Home Screen</h4>
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-title">Show Daily Mobility/Stretching</div>
            <div class="settings-row-desc">Shows the Daily Mobility/Stretching tile on this athlete's home screen. Also needs Mobility turned on for you overall in Settings.</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="settingsMobilityToggle" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-title">Show Tournaments</div>
            <div class="settings-row-desc">Shows the Tournaments tile on this athlete's home screen, where they can log upcoming competitions.</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="settingsTournamentsToggle" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-title">Let this athlete add their own workouts</div>
            <div class="settings-row-desc">Lets this athlete log strength or field workouts of their own, in addition to what you assign.</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="settingsSelfLogToggle" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <h4 class="settings-group-title">Workout Flexibility</h4>
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-title">Let this athlete add extra exercises</div>
            <div class="settings-row-desc">Lets this athlete add exercises from the library on top of what you assigned, in a workout you built.</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="settingsAddExercisesToggle" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-title">Let this athlete swap prescribed exercises</div>
            <div class="settings-row-desc">Lets this athlete substitute a different exercise from the library for one you assigned (e.g. equipment unavailable), before they've logged any sets on it.</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="settingsChangeExercisesToggle" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-title">Let this athlete move workouts to a different day</div>
            <div class="settings-row-desc">Lets this athlete reschedule a scheduled workout (including one inside a multi-week Program) to a different date, without changing the rest of their plan.</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="settingsRescheduleToggle" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <h4 class="settings-group-title">General</h4>
        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-title">Preview next week's program early</div>
            <div class="settings-row-desc">Lets this athlete see next week's scheduled workout before it becomes the current week.</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="settingsNextWeekToggle" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="settings-row">
          <div class="settings-row-info">
            <div class="settings-row-title">Let this athlete view their weekly stats</div>
            <div class="settings-row-desc">Lets this athlete open a Stats view showing workouts completed, volume, training time, and PRs for any of their last 8 weeks. On by default for new athletes.</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="settingsWeeklyStatsToggle" />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

    </div>

    <!-- ======================================================================
         MODALS
         All popups below are hidden by default (shown via the "active" class)
         and layered on top of the page content above.
         ====================================================================== -->

   <!-- Add Metric Modal: assign an existing metric to this athlete, or jump
        into the "Create New Metric" modal -->
    <div class="modal-overlay" id="addMetricModal">
      <div class="modal">
        <h2>Add Metric</h2>
        <div class="form-group">
          <label>Select Metric</label>
          <select id="metricSelect">
            <option value="">Choose a metric...</option>
          </select>
        </div>
        <p style="text-align:center; color:#aaaacc; font-size:13px; margin: 8px 0">or</p>
        <button class="btn-create-metric" id="createNewMetricBtn">+ Create New Metric</button>
        <div class="form-actions">
          <button class="btn-cancel" id="cancelMetricBtn" data-modal-dismiss>Cancel</button>
          <button class="btn-save" id="saveMetricBtn">Add to Athlete</button>
        </div>
      </div>
    </div>

    <!-- Create New Metric Modal: define a brand-new metric type (name, unit,
         category, and whether it's a "simple" or "pogo" measurement) -->
    <div class="modal-overlay" id="createMetricModal">
      <div class="modal">
        <h2>Create New Metric</h2>
        <div class="form-group">
          <label>Metric Name</label>
          <input type="text" id="newMetricName" placeholder="e.g. Standing Long Jump" />
        </div>
        <div class="form-group">
          <label>Unit</label>
          <input type="text" id="newMetricUnit" placeholder="e.g. cm, seconds, kg" />
        </div>
        <div class="form-group">
          <label>Category</label>
          <select id="newMetricCategory">
            <option value="Jumps">Jumps</option>
            <option value="Sprints">Sprints</option>
            <option value="Strength">Strength</option>
            <option value="Cardio">Cardio</option>
            <option value="Other">Other</option>
          </select>
        </div>
        <div class="form-group">
          <label>Type</label>
          <select id="newMetricType">
            <option value="simple">Simple — one value per session</option>
            <option value="pogo">Pogo — height, ground contact and RSI</option>
          </select>
        </div>
        <div class="form-actions">
          <button class="btn-cancel" id="cancelCreateMetricBtn" data-modal-dismiss>Cancel</button>
          <button class="btn-save" id="saveNewMetricBtn">Create Metric</button>
        </div>
      </div>
    </div>

    <!-- Add Measurement Modal: log a new value for a metric. Only one of the
         three field groups below (simple / pogo / zone2) is shown at a time,
         depending on the metric's type -->
    <div class="modal-overlay" id="addMeasurementModal">
      <div class="modal">
        <h2 id="measurementModalTitle">Record Measurement</h2>

        <div class="form-group">
          <label>Date</label>
          <input type="date" id="measurementDate" />
        </div>

        <!-- Simple metric fields -->
        <div id="simpleFields">
          <div class="form-group" id="singleValueGroup">
            <label id="valueLabel">Value</label>
            <input type="number" id="measurementValue" step="0.01" />
          </div>
          <div class="form-group" id="feetInchesGroup" style="display:none">
            <label>Distance</label>
            <div class="row-8">
              <input type="number" id="measurementFeet" step="1" placeholder="ft" style="flex:1" />
              <input type="number" id="measurementInches" step="0.1" min="0" max="11.9" placeholder="in" style="flex:1" />
            </div>
          </div>
        </div>

        <!-- Pogo metric fields -->
        <div id="pogoFields" style="display:none">
          <div class="form-group">
            <label id="pogoHeightLabel">Height (cm)</label>
            <input type="number" id="pogoHeight" step="0.01" />
          </div>
          <div class="form-group">
            <label>Ground Contact (ms)</label>
            <input type="number" id="pogoGroundContact" step="0.01" />
          </div>
          <div class="form-group">
            <label>RSI Score</label>
            <input type="number" id="pogoRSI" step="0.01" />
          </div>
        </div>

        <!-- Zone 2 fields -->
        <div id="zone2Fields" style="display:none">
          <div class="form-group">
            <label>Pace</label>
            <div class="row-8-center">
              <input type="number" id="zone2PaceMin" step="1" placeholder="min" style="flex:1" />
              <span class="text-muted">:</span>
              <input type="number" id="zone2PaceSec" step="1" min="0" max="59" placeholder="sec" style="flex:1" />
              <span class="text-muted-sm">min/km</span>
            </div>
          </div>
          <div class="form-group">
            <label>Avg BPM</label>
            <input type="number" id="zone2BPM" step="1" placeholder="e.g. 135" />
          </div>
          <div class="form-group">
            <label>Distance (km)</label>
            <input type="number" id="zone2Distance" step="0.01" placeholder="e.g. 7.5" />
          </div>
          <div class="form-group">
            <label>Duration</label>
            <div class="row-8-center">
              <input type="number" id="zone2DurMin" step="1" placeholder="min" style="flex:1" />
              <span class="text-muted">:</span>
              <input type="number" id="zone2DurSec" step="1" min="0" max="59" placeholder="sec" style="flex:1" />
            </div>
          </div>
        </div>

        <div class="form-group">
          <label>Notes (optional)</label>
          <input type="text" id="measurementNotes" placeholder="e.g. after warmup, windy conditions" />
        </div>

        <div class="form-actions">
          <button class="btn-cancel" id="cancelMeasurementBtn" data-modal-dismiss>Cancel</button>
          <button class="btn-save" id="saveMeasurementBtn">Save</button>
        </div>
      </div>
    </div>
<!-- Full Graph Modal: expanded Chart.js graph for one metric, with
     1M/3M/6M/1Y/All time-range filter buttons -->
    <div class="modal-overlay" id="graphModal">
      <div class="modal graph-modal">
        <div class="graph-modal-header">
          <div class="row-10-center">
            <h2 id="graphModalTitle">Progress</h2>
            <!-- % change badge for whichever time range is currently selected below -->
            <span id="graphChangeStat"></span>
          </div>
          <button class="btn-cancel" id="closeGraphBtn" data-modal-dismiss>✕</button>
        </div>
        <div class="graph-controls-row">
          <div class="graph-time-filters">
            <button class="time-filter-btn" data-months="1">1M</button>
            <button class="time-filter-btn" data-months="3">3M</button>
            <button class="time-filter-btn" data-months="6">6M</button>
            <button class="time-filter-btn" data-months="12">1Y</button>
            <button class="time-filter-btn" data-months="0">All</button>
          </div>
          <!-- Toggle: overlays bodyweight (indexed to % change) on top of this
               metric's line, for whichever time range is selected above -->
          <label class="bodyweight-toggle">
            <span>Bodyweight</span>
            <span class="toggle-switch">
              <input type="checkbox" id="bodyweightOverlayToggle" />
              <span class="toggle-slider"></span>
            </span>
          </label>
        </div>
        <!-- Only shown for Zone 2 metrics: total km run in the currently selected time filter -->
        <p class="graph-period-stat" id="graphPeriodStat"></p>
        <div class="graph-container">
          <canvas id="fullGraph"></canvas>
        </div>
        <!-- Which granularity the points above are averaged to (auto-scaled
             to the selected time range - see GRANULARITY_FOR_MONTHS), blank
             for the 1M view which shows raw entries -->
        <p class="graph-granularity-note" id="graphGranularityNote"></p>
      </div>
    </div>
    <!-- Entries Modal: full history table (all measurements) for one metric -->
    <div class="modal-overlay" id="entriesModal">
      <div class="modal">
        <div class="graph-modal-header">
          <h2 id="entriesModalTitle">All Entries</h2>
          <button class="btn-cancel" id="closeEntriesBtn" data-modal-dismiss>✕</button>
        </div>
      <div class="entries-modal-body">
          <div id="entriesList"></div>
        </div>
      </div>
    </div>

    <!-- PR Overview Modal: opened by clicking the "PRs in last 30 days" stat.
         Shows which PRs were broken, grouped by category then by individual
         metric, with each metric's PRs listed chronologically -->
    <div class="modal-overlay" id="prModal">
      <div class="modal">
        <div class="graph-modal-header">
          <h2>PRs in the Last 30 Days</h2>
          <button class="btn-cancel" id="closePRModalBtn" data-modal-dismiss>✕</button>
        </div>
        <div class="entries-modal-body">
          <div id="prList"></div>
        </div>
      </div>
    </div>

    <!-- Duration Detail Modal: opened by clicking the "Avg Duration (30d)"
         stat. Individual completed workout sessions, most recent first -->
    <div class="modal-overlay" id="durationDetailModal">
      <div class="modal">
        <div class="graph-modal-header">
          <h2>Workout Durations</h2>
          <button class="btn-cancel" id="closeDurationModalBtn" data-modal-dismiss>✕</button>
        </div>
        <div class="entries-modal-body">
          <div id="durationList"></div>
        </div>
      </div>
    </div>

    <!-- Completion Detail Modal: opened by clicking the "Completion (30d)"
         stat. Same underlying data, just broken out into all three windows -->
    <div class="modal-overlay" id="completionDetailModal">
      <div class="modal">
        <div class="graph-modal-header">
          <h2>Workout Completion</h2>
          <button class="btn-cancel" id="closeCompletionModalBtn" data-modal-dismiss>✕</button>
        </div>
        <p class="panel-subtitle">Share of scheduled workout days where every prescribed set was logged. Rest days aren't counted either way.</p>
        <div class="stats-bar" id="completionDetailBar">
          <div class="stat-item">
            <span class="stat-value" id="statCompletion30">—</span>
            <span class="stat-label">Last 30 days</span>
          </div>
          <div class="stat-item">
            <span class="stat-value" id="statCompletion60">—</span>
            <span class="stat-label">Last 60 days</span>
          </div>
          <div class="stat-item">
            <span class="stat-value" id="statCompletion90">—</span>
            <span class="stat-label">Last 90 days</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Volume Detail Modal: opened by clicking the "Volume (7d)" stat.
         A trend, not just a number, is what actually shows overtraining risk -->
    <div class="modal-overlay" id="volumeDetailModal">
      <div class="modal">
        <div class="graph-modal-header">
          <h2>Weekly Workout Volume</h2>
          <button class="btn-cancel" id="closeVolumeModalBtn" data-modal-dismiss>✕</button>
        </div>
        <p class="panel-subtitle">Total weight × reps logged per week, last 12 weeks.</p>
        <div class="bodyweight-graph-area" style="height:260px">
          <canvas id="volumeChart"></canvas>
          <p class="no-bodyweight-data" id="noVolumeMsg" style="display:none">No logged sets with a weight yet</p>
        </div>
      </div>
    </div>

    <!-- Weekly Load Detail Modal: opened by clicking the "Weekly Load (7d)" stat -->
    <div class="modal-overlay" id="weeklyLoadDetailModal">
      <div class="modal">
        <div class="graph-modal-header">
          <h2>Weekly Training Load</h2>
          <button class="btn-cancel" id="closeWeeklyLoadModalBtn" data-modal-dismiss>✕</button>
        </div>
        <p class="panel-subtitle">Foster's session-RPE method: each workout's effort rating (1-10) × how long it took (minutes), summed across the last 7 days. It's a way to compare load across totally different training types - weights, sprints, conditioning - on one scale, since it's based on how hard it actually felt rather than what got programmed. Only workouts with an effort rating count.</p>
        <div id="weeklyLoadList"></div>
      </div>
    </div>

    <!-- ACWR Detail Modal: opened by clicking the "ACWR" stat -->
    <div class="modal-overlay" id="acwrDetailModal">
      <div class="modal">
        <div class="graph-modal-header">
          <h2>Acute:Chronic Workload Ratio</h2>
          <button class="btn-cancel" id="closeAcwrModalBtn" data-modal-dismiss>✕</button>
        </div>
        <p class="panel-subtitle">Compares this week's training load (acute) to this athlete's typical load over the last 4 weeks (chronic). Roughly 0.8-1.3 is the "sweet spot" - training hard but sustainably. Below 0.8 can mean undertrained. Above 1.5 is linked to a meaningfully higher injury risk - load has ramped up faster than the body's had time to adapt to.</p>
        <div class="stats-bar" id="acwrDetailBar">
          <div class="stat-item">
            <span class="stat-value" id="statAcuteLoad">—</span>
            <span class="stat-label">Acute (7d)</span>
          </div>
          <div class="stat-item">
            <span class="stat-value" id="statChronicLoad">—</span>
            <span class="stat-label">Chronic (28d avg)</span>
          </div>
          <div class="stat-item">
            <span class="stat-value" id="statAcwrDetail">—</span>
            <span class="stat-label">Ratio</span>
          </div>
        </div>
        <p class="stat-insufficient-note" id="acwrInsufficientNote" style="display:none"></p>
      </div>
    </div>

    <!-- Monotony Detail Modal: opened by clicking the "Monotony" stat -->
    <div class="modal-overlay" id="monotonyDetailModal">
      <div class="modal">
        <div class="graph-modal-header">
          <h2>Training Monotony</h2>
          <button class="btn-cancel" id="closeMonotonyModalBtn" data-modal-dismiss>✕</button>
        </div>
        <p class="panel-subtitle">How varied this week's training load was, day to day (average daily load ÷ how much it swung around that average). The same total load spread evenly across 7 similar days is riskier than the same total load with real hard days and easy/rest days built in - low monotony means more variation, which is generally safer even at the same overall volume.</p>
      </div>
    </div>

    <!-- Strain Detail Modal: opened by clicking the "Strain" stat -->
    <div class="modal-overlay" id="strainDetailModal">
      <div class="modal">
        <div class="graph-modal-header">
          <h2>Training Strain</h2>
          <button class="btn-cancel" id="closeStrainModalBtn" data-modal-dismiss>✕</button>
        </div>
        <p class="panel-subtitle">Weekly Load × Monotony. Combines how much training was done with how repetitive the week was - a high strain number means a lot of load packed into a monotonous week (little variation between hard and easy days), which research links to a higher risk of injury or illness.</p>
      </div>
    </div>

    <!-- Report Builder Modal: opened by "Generate Report" at the top of the
         Metrics tab. Checklist only shows sections with real data (filled
         in by renderReportChecklist()), then a time-period picker, then
         "Generate PDF" opens the finished PDF in a new tab -->
    <div class="modal-overlay" id="reportBuilderModal">
      <div class="modal">
        <div class="graph-modal-header">
          <h2>Generate Progress Report</h2>
          <button class="btn-cancel" id="closeReportBuilderModalBtn" data-modal-dismiss>✕</button>
        </div>
        <p style="color:#aaaacc; font-size:13px; margin-top:-8px">Choose what to include - only sections with logged data are shown.</p>
        <div id="reportSectionChecklist" class="chip-row"></div>
        <p class="bodyweight-label" style="margin-top:20px">Time Period</p>
        <div class="graph-time-filters" id="reportMonthsRow">
          <button type="button" class="time-filter-btn" data-months="1">1M</button>
          <button type="button" class="time-filter-btn active" data-months="3">3M</button>
          <button type="button" class="time-filter-btn" data-months="6">6M</button>
          <button type="button" class="time-filter-btn" data-months="9">9M</button>
          <button type="button" class="time-filter-btn" data-months="12">12M</button>
        </div>
        <label class="bodyweight-toggle" style="margin-top:20px">
          <span id="reportSendToChatLabel">Also send to chat</span>
          <span class="toggle-switch"><input type="checkbox" id="reportSendToChat"><span class="toggle-slider"></span></span>
        </label>
        <div class="form-actions" style="margin-top:24px">
          <button type="button" class="btn-save" id="generatePdfBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-inline-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>Generate PDF</button>
        </div>
      </div>
    </div>

    <!-- Metrics Tracked Modal: opened by clicking the "Metrics tracked" stat.
         Lists every metric currently assigned to this athlete, grouped by category -->
    <div class="modal-overlay" id="metricsTrackedModal">
      <div class="modal">
        <div class="graph-modal-header">
          <h2>Metrics Tracked</h2>
          <button class="btn-cancel" id="closeMetricsTrackedModalBtn" data-modal-dismiss>✕</button>
        </div>
        <div class="entries-modal-body">
          <div id="metricsTrackedList"></div>
        </div>
      </div>
    </div>

    <!-- Total Entries Modal: opened by clicking the "Total entries" stat.
         Shows how many measurements are logged per metric, grouped by category -->
    <div class="modal-overlay" id="totalEntriesModal">
      <div class="modal">
        <div class="graph-modal-header">
          <h2>Total Entries</h2>
          <button class="btn-cancel" id="closeTotalEntriesModalBtn" data-modal-dismiss>✕</button>
        </div>
        <div class="entries-modal-body">
          <div id="totalEntriesList"></div>
        </div>
      </div>
    </div>

    <!-- Last Updated Modal: opened by clicking the "Last updated" stat.
         Reverse-chronological feed of the most recently logged entries -->
    <div class="modal-overlay" id="lastUpdatedModal">
      <div class="modal">
        <div class="graph-modal-header">
          <h2>Recent Activity</h2>
          <button class="btn-cancel" id="closeLastUpdatedModalBtn" data-modal-dismiss>✕</button>
        </div>
        <div class="entries-modal-body">
          <div id="lastUpdatedList"></div>
        </div>
      </div>
    </div>

    <!-- Edit Entry Modal: edit one existing measurement. Like the Add
         Measurement modal, only the matching field group (simple/pogo/zone2)
         is shown, based on the metric being edited -->
    <div class="modal-overlay" id="editEntryModal">
      <div class="modal">
        <h2>Edit Entry</h2>
        <div class="form-group">
          <label>Date</label>
          <input type="date" id="editEntryDate" />
        </div>
        <div id="editSimpleFields">
          <div class="form-group" id="editSingleValueGroup">
            <label id="editValueLabel">Value</label>
            <input type="number" id="editEntryValue" step="0.01" />
          </div>
          <div class="form-group" id="editFeetInchesGroup" style="display:none">
            <label>Distance</label>
            <div class="row-8">
              <input type="number" id="editEntryFeet" step="1" placeholder="ft" style="flex:1" />
              <input type="number" id="editEntryInches" step="0.1" min="0" max="11.9" placeholder="in" style="flex:1" />
            </div>
          </div>
        </div>
        <div id="editPogoFields" style="display:none">
          <div class="form-group">
            <label>Height (cm)</label>
            <input type="number" id="editPogoHeight" step="0.01" />
          </div>
          <div class="form-group">
            <label>Ground Contact (ms)</label>
            <input type="number" id="editPogoGroundContact" step="0.01" />
          </div>
          <div class="form-group">
            <label>RSI Score</label>
            <input type="number" id="editPogoRSI" step="0.01" />
          </div>
        </div>

       <div id="editZone2Fields" style="display:none">
          <div class="form-group">
            <label>Pace</label>
            <div class="row-8-center">
              <input type="number" id="editZone2PaceMin" step="1" placeholder="min" style="flex:1" />
              <span class="text-muted">:</span>
              <input type="number" id="editZone2PaceSec" step="1" min="0" max="59" placeholder="sec" style="flex:1" />
              <span class="text-muted-sm">min/km</span>
            </div>
          </div>
          <div class="form-group">
            <label>Avg BPM</label>
            <input type="number" id="editZone2BPM" step="1" />
          </div>
          <div class="form-group">
            <label>Distance (km)</label>
            <input type="number" id="editZone2Distance" step="0.01" />
          </div>
          <div class="form-group">
            <label>Duration</label>
            <div class="row-8-center">
              <input type="number" id="editZone2DurMin" step="1" placeholder="min" style="flex:1" />
              <span class="text-muted">:</span>
              <input type="number" id="editZone2DurSec" step="1" min="0" max="59" placeholder="sec" style="flex:1" />
            </div>
          </div>
        </div>
        <div class="form-group">
          <label>Notes (optional)</label>
          <input type="text" id="editEntryNotes" />
        </div>
        <div class="form-actions">
          <button class="btn-cancel" id="cancelEditEntryBtn" data-modal-dismiss>Cancel</button>
          <button class="btn-save" id="saveEditEntryBtn">Save Changes</button>
        </div>
      </div>
    </div>
    <!-- Edit Athlete Info Modal: update name, DOB, gender, height.
         Weight is intentionally NOT editable here - it's tracked via the
         separate Bodyweight feature (dated entries, see loadBodyweightGraph) -->
    <div class="modal-overlay" id="editAthleteModal">
      <div class="modal">
        <div class="graph-modal-header">
          <h2>Edit Athlete Info</h2>
          <button class="btn-cancel" id="closeEditAthleteBtn">✕</button>
        </div>
        <div class="form-group">
          <label>Full Name</label>
          <input type="text" id="editAthleteName" />
        </div>
        <div class="form-group">
          <label>Date of Birth</label>
          <input type="date" id="editAthleteDOB" />
        </div>
        <div class="form-group">
          <label>Gender</label>
          <select id="editAthleteGender">
            <option value="Male">Male</option>
            <option value="Female">Female</option>
            <option value="Other">Other</option>
          </select>
        </div>
        <div class="form-group">
          <label>Height (cm)</label>
          <input type="number" id="editAthleteHeight" />
        </div>
        <div class="form-group">
          <label>Email (for athlete login)</label>
          <input type="email" id="editAthleteEmail" placeholder="athlete@email.com" />
          <div style="display:flex; gap:8px; margin-top:8px" id="editAthleteInviteActions">
            <button type="button" class="unit-btn" id="resendInviteBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-inline-icon"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22 6 12 13 2 6"></polyline></svg>Resend Invite</button>
            <button type="button" class="unit-btn" id="copyInviteLinkBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-inline-icon"><path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3"></path><line x1="8" y1="12" x2="16" y2="12"></line></svg>Copy Invite Link</button>
          </div>
        </div>
        <div class="form-actions">
          <button class="btn-cancel" id="cancelEditAthleteBtn" data-modal-dismiss>Cancel</button>
          <button class="btn-save" id="saveEditAthleteBtn">Save Changes</button>
        </div>
      </div>
    </div>
    <!-- Log Bodyweight Modal: add a new bodyweight entry (kg or lbs input) -->
    <div class="modal-overlay" id="bodyweightModal">
      <div class="modal">
        <div class="graph-modal-header">
          <h2>Log Bodyweight</h2>
          <button class="btn-cancel" id="closeBodyweightBtn">✕</button>
        </div>
        <div class="form-group">
          <label>Date</label>
          <input type="date" id="bodyweightDate" />
        </div>
        <div class="form-group">
          <label id="bodyweightInputLabel">Weight</label>
          <div class="row-8">
            <input type="number" id="bodyweightValue" step="0.1" placeholder="e.g. 75.5" style="flex:3" />
            <select id="bodyweightInputUnit" style="flex:1">
              <option value="kg">kg</option>
              <option value="lbs">lbs</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Notes (optional)</label>
          <input type="text" id="bodyweightNotes" placeholder="e.g. morning weight" />
        </div>
        <div class="form-actions">
          <button class="btn-cancel" id="cancelBodyweightBtn" data-modal-dismiss>Cancel</button>
          <button class="btn-save" id="saveBodyweightBtn">Save</button>
        </div>
      </div>
    </div>
    <!-- Bodyweight Entries Modal: full history table of bodyweight logs -->
    <div class="modal-overlay" id="bwEntriesModal">
      <div class="modal">
        <div class="graph-modal-header">
          <h2>Bodyweight Entries</h2>
          <button class="btn-cancel" id="closeBWEntriesBtn" data-modal-dismiss>✕</button>
        </div>
        <div id="bwEntriesList"></div>
      </div>
    </div>

    <!-- Edit Bodyweight Entry Modal: edit one existing bodyweight entry -->
    <div class="modal-overlay" id="editBWEntryModal">
      <div class="modal">
        <h2>Edit Bodyweight Entry</h2>
        <div class="form-group">
          <label>Date</label>
          <input type="date" id="editBWDate" />
        </div>
        <div class="form-group">
          <label>Weight</label>
          <div class="row-8">
            <input type="number" id="editBWValue" step="0.1" style="flex:3" />
            <select id="editBWUnit" style="flex:1">
              <option value="kg">kg</option>
              <option value="lbs">lbs</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label>Notes (optional)</label>
          <input type="text" id="editBWNotes" />
        </div>
        <div class="form-actions">
          <button class="btn-cancel" id="cancelEditBWBtn" data-modal-dismiss>Cancel</button>
          <button class="btn-save" id="saveEditBWBtn">Save Changes</button>
        </div>
      </div>
    </div>

    <!-- Add Note Modal: logs a new dated note for this athlete -->
    <div class="modal-overlay" id="addNoteModal">
      <div class="modal">
        <div class="graph-modal-header">
          <h2>Add Note</h2>
          <button class="btn-cancel" id="closeAddNoteBtn">✕</button>
        </div>
        <div class="form-group">
          <label>Date</label>
          <input type="date" id="noteDate" />
        </div>
        <div class="form-group">
          <label>Note</label>
          <textarea id="noteText" class="notes-textarea" placeholder="Injury history, coaching cues, observations..."></textarea>
        </div>
        <div class="form-actions">
          <button class="btn-cancel" id="cancelAddNoteBtn" data-modal-dismiss>Cancel</button>
          <button class="btn-save" id="saveNoteBtn">Save</button>
        </div>
      </div>
    </div>

    <!-- Notes List Modal: full dated history of notes, with edit/delete per entry -->
    <div class="modal-overlay" id="notesListModal">
      <div class="modal modal-wide">
        <div class="graph-modal-header">
          <h2>All Notes</h2>
          <button class="btn-cancel" id="closeNotesListBtn" data-modal-dismiss>✕</button>
        </div>
        <div class="entries-modal-body">
          <div id="notesList"></div>
        </div>
      </div>
    </div>

    <!-- Edit Note Modal: edit one existing dated note -->
    <div class="modal-overlay" id="editNoteModal">
      <div class="modal">
        <h2>Edit Note</h2>
        <div class="form-group">
          <label>Date</label>
          <input type="date" id="editNoteDate" />
        </div>
        <div class="form-group">
          <label>Note</label>
          <textarea id="editNoteText" class="notes-textarea"></textarea>
        </div>
        <div class="form-actions">
          <button class="btn-cancel" id="cancelEditNoteBtn" data-modal-dismiss>Cancel</button>
          <button class="btn-save" id="saveEditNoteBtn">Save Changes</button>
        </div>
      </div>
    </div>

    <!-- % Change Explanation Modal: shows the math behind a metric's ▲/▼ % badge -->
    <div class="modal-overlay" id="changeExplainModal">
      <div class="modal">
        <div class="graph-modal-header">
          <h2 id="changeExplainTitle">Performance Change</h2>
          <button class="btn-cancel" id="closeChangeExplainBtn" data-modal-dismiss>✕</button>
        </div>
        <div id="changeExplainContent"></div>
      </div>
    </div>

    <!-- ======================================================================
         CALENDAR TAB MODALS
         ====================================================================== -->

    <!-- Day Detail Modal: everything scheduled on one date, grouped by which
         program it came from (an assigned template, or "Ad-hoc") -->
    <div class="modal-overlay" id="dayDetailModal">
      <div class="modal">
        <div class="graph-modal-header">
          <h2 id="dayDetailTitle">Workout</h2>
          <button class="btn-cancel" id="closeDayDetailBtn" data-modal-dismiss>✕</button>
        </div>
        <div class="entries-modal-body" id="dayDetailContent"></div>
      </div>
    </div>

    <!-- Add Training popup: opens from the small "+" that appears when
         hovering a calendar day (see .calendar-day-add-btn). Two tabs: drop
         a single saved Training onto just this day, or assign a whole
         multi-week Program starting on this day - same underlying flows as
         before, just reachable from one popup instead of two. -->
    <div class="modal-overlay" id="dayAddTrainingModal">
      <div class="modal modal-wide">
        <div class="graph-modal-header">
          <h2 id="dayAddTrainingTitle">Add to Calendar</h2>
          <button class="btn-cancel" id="closeDayAddTrainingBtn" data-modal-dismiss>✕</button>
        </div>

        <div class="modal-tab-bar">
          <button type="button" class="modal-tab-btn active" id="dayAddTabWorkout">Single Workout</button>
          <button type="button" class="modal-tab-btn" id="dayAddTabProgram">Program</button>
          <button type="button" class="modal-tab-btn" id="dayAddTabSection">Section</button>
          <button type="button" class="modal-tab-btn" id="dayAddTabForm">Form</button>
          <button type="button" class="modal-tab-btn" id="dayAddTabTournament">Tournament</button>
        </div>

        <!-- Left: pick a saved Training - clicking one previews it on the
             right instead of applying it immediately, so a wrong click
             doesn't put something on the calendar by accident. -->
        <div class="modal-tab-panel active" id="dayAddWorkoutPanel">
          <div class="day-add-workout-layout">
            <div class="day-add-workout-list-col">
              <div class="day-add-workout-list-header">
                <span class="day-add-workout-list-title">Workouts</span>
                <button type="button" class="btn-small-create" id="newTrainingFromDayBtn">+ New</button>
              </div>
              <div class="entries-modal-body" id="dayAddTrainingList"></div>
            </div>
            <div class="day-add-workout-preview" id="dayAddTrainingPreview">
              <p class="no-metrics">Select a workout to preview it</p>
            </div>
          </div>
          <div class="form-actions form-actions-end">
            <button class="btn-save" id="selectTrainingForDayBtn" disabled>Select</button>
          </div>
        </div>

        <!-- Left: pick a Program template - previews its full day list on
             the right, same pattern as the Single Workout tab. No start
             date field: the day you clicked is always day 1 of whatever
             range you pick below, so asking for it again would be
             redundant. The day range fields open dayPickerModal. -->
        <div class="modal-tab-panel" id="dayAddProgramPanel">
          <div class="day-add-workout-layout">
            <div class="day-add-workout-list-col">
              <div class="day-add-workout-list-header">
                <span class="day-add-workout-list-title">Programs</span>
                <a href="../programs.html" target="_blank" class="btn-small-create">+ New</a>
              </div>
              <div class="entries-modal-body" id="dayAddProgramList"></div>
            </div>
            <div class="day-add-workout-preview" id="dayAddProgramPreview">
              <p class="no-metrics">Select a program to preview it</p>
            </div>
          </div>

          <div class="day-range-row" id="dayRangeRow" style="display:none">
            <span class="day-range-caption">Schedule from</span>
            <button type="button" class="day-range-field" id="programStartDayField">
              <span id="programStartDayLabel">Day 1</span> <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
            </button>
            <span class="day-range-arrow">→</span>
            <button type="button" class="day-range-field" id="programEndDayField">
              <span id="programEndDayLabel">Day 1</span> <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
            </button>
          </div>

          <div class="form-actions form-actions-end">
            <button class="btn-save" id="saveDayAddProgramBtn" disabled>Assign Program</button>
          </div>
        </div>

        <!-- Left: pick a saved Section - same list-then-preview pattern as
             the Single Workout tab. Insert bulk-copies the section's
             exercises onto this day, offset past whatever's already there. -->
        <div class="modal-tab-panel" id="dayAddSectionPanel">
          <div class="day-add-workout-layout">
            <div class="day-add-workout-list-col">
              <div class="day-add-workout-list-header">
                <span class="day-add-workout-list-title">Sections</span>
                <a href="../sections.html" target="_blank" class="btn-small-create">+ New</a>
              </div>
              <div class="entries-modal-body" id="dayAddSectionList"></div>
            </div>
            <div class="day-add-workout-preview" id="dayAddSectionPreview">
              <p class="no-metrics">Select a section to preview it</p>
            </div>
          </div>
          <div class="form-actions form-actions-end">
            <button class="btn-save" id="selectSectionForDayBtn" disabled>Insert</button>
          </div>
        </div>

        <!-- Left: pick a Form - same list-then-preview pattern as Section,
             just previewing questions instead of exercises. Assigning
             writes a form_assignments row directly (no program_day
             involved at all - forms aren't exercises). -->
        <div class="modal-tab-panel" id="dayAddFormPanel">
          <div class="day-add-workout-layout">
            <div class="day-add-workout-list-col">
              <div class="day-add-workout-list-header">
                <span class="day-add-workout-list-title">Forms</span>
                <a href="../forms.html" target="_blank" class="btn-small-create">+ New</a>
              </div>
              <div class="entries-modal-body" id="dayAddFormList"></div>
            </div>
            <div class="day-add-workout-preview" id="dayAddFormPreview">
              <p class="no-metrics">Select a form to preview it</p>
            </div>
          </div>
          <div class="form-actions form-actions-end">
            <button class="btn-save" id="selectFormForDayBtn" disabled>Assign</button>
          </div>
        </div>

        <!-- Put a tournament the athlete mentioned (say, on a call) straight
             on their calendar - it shows up for them right away. Same fields
             as the athlete's own Add Tournament form (name, dates, 1-5
             importance) but the rating is coach-only: it's stored in
             tournament_coach_ratings, which the athlete has no access to at
             all (see sql-history.sql), and saved with the
             coach_add_tournament() database function in one call. -->
        <div class="modal-tab-panel" id="dayAddTournamentPanel">
          <p class="coach-tournament-intro">Add a tournament your athlete mentioned - it appears on their calendar straight away.</p>
          <div class="form-group">
            <label for="coachTournamentName">Tournament name</label>
            <input type="text" id="coachTournamentName" placeholder="e.g. State Championships" maxlength="80" />
          </div>
          <div class="coach-tournament-dates">
            <div class="form-group">
              <label for="coachTournamentStart">Start date</label>
              <input type="date" id="coachTournamentStart" />
            </div>
            <div class="form-group">
              <label for="coachTournamentEnd">End date</label>
              <input type="date" id="coachTournamentEnd" />
            </div>
          </div>
          <div class="coach-importance-picker">
            <p class="coach-importance-label">How important is this tournament?</p>
            <div class="coach-importance-row">
              ${[1, 2, 3, 4, 5].map(n => `<button type="button" class="coach-importance-btn" data-importance="${n}">${n}</button>`).join('')}
            </div>
            <p class="coach-importance-hint" id="coachTournamentImportanceHint">Tap a number to see what it means</p>
            <p class="coach-tournament-private"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg> Only you can see this rating - your athlete just sees the tournament and its dates.</p>
          </div>
          <div class="form-actions form-actions-end">
            <button class="btn-save" id="saveCoachTournamentBtn">Add Tournament</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Nested on top of the Add Training modal: a paginated grid of day
         numbers (4 weeks/28 days per page) for picking where in a Program
         to start/end - see openDayPicker() -->
    <div class="modal-overlay" id="dayPickerModal">
      <div class="modal">
        <h2>Choose Day</h2>
        <div class="day-picker-nav">
          <button type="button" class="btn-cancel" id="dayPickerPrevBtn">‹</button>
          <span id="dayPickerRangeLabel"></span>
          <button type="button" class="btn-cancel" id="dayPickerNextBtn">›</button>
        </div>
        <div class="day-picker-grid" id="dayPickerGrid"></div>
        <div class="form-actions" style="justify-content:center; margin-top:16px">
          <button class="btn-cancel" id="dayPickerCancelBtn" data-modal-dismiss>Cancel</button>
        </div>
      </div>
    </div>

    <!-- Quick "name it" step before opening the Training Builder overlay -->
    <div class="modal-overlay" id="newTrainingNameModal">
      <div class="modal">
        <h2>New Workout</h2>
        <div class="form-group">
          <label>Name</label>
          <input type="text" id="newTrainingNameInput" placeholder="e.g. Leg Day" />
        </div>
        <div class="form-actions">
          <button class="btn-cancel" id="cancelNewTrainingNameBtn" data-modal-dismiss>Cancel</button>
          <button class="btn-save" id="saveNewTrainingNameBtn">Create & Build</button>
        </div>
      </div>
    </div>

    <!-- Workout Builder Overlay: the Workout Builder (screens/
         training-builder.js, via builder-overlay.js) rendered into
         #trainingBuilderHost, so a training can be built without
         navigating away from the calendar. Same builder as the Workout
         Library's own screen. -->
    <div class="modal-overlay" id="trainingBuilderOverlayModal">
      <div class="modal modal-large">
        <div class="graph-modal-header">
          <h2>Build Workout</h2>
          <button class="btn-save" id="doneTrainingBuilderBtn" data-modal-dismiss>Done</button>
        </div>
        <div id="trainingBuilderHost" class="training-builder-frame tb-host"></div>
      </div>
    </div>

    <!-- Brief self-dismissing confirmation - see showToast() -->
    <div class="toast-notice" id="pageToast"></div>
`
