// ==========================================================================
// ATHLETE DETAIL — screen
// Converted from the repo-root athlete.js (3,818 lines) + athlete-calendar.js
// (2,869 lines) + the .profile block and every modal of athlete.html. This
// is the app's largest and most complex screen: a 4-tab drill-down (Overview
// / Metrics / Calendar / Settings) reached by tapping an athlete card on the
// Athletes screen - see athletes.js's createAthleteCard, which calls
// go('athlete-detail', { id: athlete.id }).
//
// The two original files were already split along a clean seam (measurement
// data vs. program/calendar data) and, conveniently, already namespaced
// almost every helper to avoid colliding with each other (the Ov/Idx suffix
// convention in the Overview/Metrics half, the Cal suffix in the Calendar
// half) - so this merge is close to a literal concatenation of the two,
// structurally. What actually changed, mirroring the pattern athletes.js and
// trainings.js already established:
//
//   - the session check + redirect at the top of athlete.js, and the second
//     (silent) one at the top of athlete-calendar.js, are both gone - the
//     bootstrap in dashboard.js does this once, and every session.user.id
//     became coachId()
//   - both files independently read `new URLSearchParams(location.search)
//     .get('id')` - now one read of params.id (the exact key athletes.js's
//     createAthleteCard passes to go('athlete-detail', ...); note this is
//     `id`, NOT `athleteId` - see the report for why that matters), shared
//     by both halves of this module as one `athleteId` var
//   - every document.getElementById/querySelectorAll moved inside mount()
//     or a function it calls, scoped via root.querySelector/
//     querySelectorAll, because this module is now imported before its
//     markup exists. The three genuinely document/window-level listeners
//     (visibilitychange for the Overview auto-refresh, an outside-click that
//     closes calendar kebab dropdowns, and an Escape-key handler that
//     disarms an in-progress calendar copy) are registered in mount() and
//     explicitly removed in unmount() - left attached they would accumulate
//     one copy per visit for the life of the app, same risk athletes.js
//     called out for its own single document click listener, just three
//     times over here given this screen's size.
//   - athlete-calendar.js's `window.dispatchEvent(new CustomEvent(
//     'calendar-tab-activated'))` / `window.addEventListener(...)` round
//     trip only ever existed because the two files had no shared scope to
//     call into each other with. Now that they're one module, it's just a
//     plain function call (activateCalendarTab()) from the tab-click
//     handler - simpler, and removes a real "leaks across screens" SPA risk
//     since a window listener would otherwise outlive this screen entirely
//   - window.location.href = 'x.html?id=N' navigation (there wasn't any
//     inside these two files themselves - both are already the destination
//     of that kind of link from script.js/dashboard.js) has no equivalent
//     here; the training-builder iframe overlay is untouched (still points
//     at the unchanged repo-root training-builder.html?...&embed=1 - that
//     conversion is Phase 5, out of scope here)
//   - Chart.js and jsPDF are no longer loaded unconditionally via
//     <script defer> in athlete.html's <head> on every visit - see
//     vendor.js. await loadChartJs() now sits immediately before every
//     `new Chart(...)` call site instead (there are five: the bodyweight
//     graph and the Volume detail modal on Overview, the per-metric mini
//     graphs and the full graph modal on Metrics, and the PDF report's
//     trend charts) and await loadJsPdf() sits at the top of
//     generateReportPDF(), replacing the old `if (!window.jspdf)` guard
//     that used to compensate for the deferred script maybe not having
//     finished loading yet - loadJsPdf()'s promise IS that guarantee now.
//     Metrics/Calendar's own DATA still only loads the first time that tab
//     is clicked (metricsLoaded/calendarLoaded flags, unchanged) - Chart.js
//     sizes its canvases from their rendered pixel dimensions, so drawing
//     graphs while a panel is still display:none would produce blank/
//     squashed charts. See the report for a real discrepancy this surfaced:
//     Overview draws a Chart.js bodyweight graph AND has its own
//     Chart.js-backed Volume detail modal, so a coach who never opens
//     Metrics or Calendar still downloads Chart.js today, same as before -
//     that's inherent to what Overview already renders, not something this
//     conversion could avoid without changing what the tab shows.
//   - every await in mount() (and in the tab-switch handler that lazily
//     loads Metrics/Calendar) is followed by nav.isCurrent(token) before
//     the DOM is touched again
//   - overviewLoadInFlight/lastOverviewAutoRefresh (the guard that stops a
//     second overlapping Overview refresh from firing the same 3 queries
//     again - athlete.js's own comment says this exact bug caused a
//     production statement-timeout incident) is preserved exactly as-is
//   - this is the first real drill-down screen (Phase 4) - screens/
//     _placeholder.js is the only existing precedent for the back-button
//     header a drill-down needs to render for itself, so that pattern
//     (screen-header / btn-back / screen-title) is reproduced here
//
// See screens/_placeholder.js for the full mount/unmount contract, and
// screens/athletes.js / screens/trainings.js for the conventions this
// follows.
// ==========================================================================
import { supabase } from '../../coachClient.js'
import { sendPush } from '../../push.js'
import * as nav from '../nav.js'
import { go } from '../router.js'
import { coachId } from '../session.js'
import { loadChartJs, loadJsPdf } from '../vendor.js'
import { ensureCss } from '../lazy-css.js'

// Shown for however long the initial athlete-row fetch takes - same
// "skeleton, not a blank screen" convention as athletes.js/trainings.js.
// Carries its own back button so leaving is possible even before the real
// TEMPLATE (and its own back button) has painted.
const SKELETON = `
  <div class="screen-header">
    <button class="btn-back" id="athleteDetailBackBtn" aria-label="Back">←</button>
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
const TEMPLATE = `
  <div class="screen-header">
    <button class="btn-back" id="athleteDetailBackBtn" aria-label="Back">←</button>
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
           .overview-top-split in athlete.css -->
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
          <button class="btn-cancel" id="calPrevBtn">← Prev</button>
          <h3 id="calMonthLabel">&nbsp;</h3>
          <button class="btn-cancel" id="calNextBtn">Next →</button>
        </div>
        <!-- Static - the grid below always starts each row on Monday (see
             renderCalendarGrid's startWeekday math), so this never needs to
             be regenerated per month. Leading empty span lines the header up
             with the copy-icon gutter column #calendarGrid gets in JS (see
             the #calendarWeekdayHeader/#calendarGrid grid-template-columns
             overrides in athlete.css). -->
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
          <h2 id="dayAddTrainingTitle">Add Workout</h2>
          <button class="btn-cancel" id="closeDayAddTrainingBtn" data-modal-dismiss>✕</button>
        </div>

        <div class="modal-tab-bar">
          <button type="button" class="modal-tab-btn active" id="dayAddTabWorkout">Single Workout</button>
          <button type="button" class="modal-tab-btn" id="dayAddTabProgram">Program</button>
          <button type="button" class="modal-tab-btn" id="dayAddTabSection">Section</button>
          <button type="button" class="modal-tab-btn" id="dayAddTabForm">Form</button>
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

    <!-- Training Builder Overlay: training-builder.html loaded in an iframe
         so a training can be built without navigating away from the
         calendar. Same page/logic as the standalone Training Library.
         Untouched/out of scope - see the banner comment at the top of this
         file; only the JS that opens/closes this overlay and sets the
         iframe src is converted here. -->
    <div class="modal-overlay" id="trainingBuilderOverlayModal">
      <div class="modal modal-large">
        <div class="graph-modal-header">
          <h2>Build Workout</h2>
          <button class="btn-save" id="doneTrainingBuilderBtn" data-modal-dismiss>Done</button>
        </div>
        <iframe id="trainingBuilderFrame" class="training-builder-frame" src="about:blank"></iframe>
      </div>
    </div>

    <!-- Shown only while linking a superset on the Calendar tab - see
         updatePickingModeBarCal() -->
    <div class="picking-mode-bar" id="pickingModeBar" style="display:none">
      <span class="picking-mode-bar-count" id="pickingModeBarCount"></span>
      <div class="picking-mode-bar-actions">
        <button type="button" class="btn-cancel" id="pickingModeBarCancelBtn">Cancel</button>
        <button type="button" class="btn-save" id="pickingModeBarFinishBtn">✓ Finish Superset</button>
      </div>
    </div>

    <!-- Brief self-dismissing confirmation - see showToast() -->
    <div class="toast-notice" id="pageToast"></div>
`

let root = null
// The mount's nav token. Read by every background load (loadOverviewStats,
// loadRecentActivity, the Metrics/Calendar lazy-tab loads, ...) after its
// own await, same isCurrent(token) guard every other screen uses - a slow
// response landing after the coach has navigated away (back to Athletes, or
// into a different athlete entirely) must never repaint over whatever
// screen is showing by then.
let mountToken = null

// athleteId comes from params.id - the exact key athletes.js's
// createAthleteCard passes to go('athlete-detail', { id: athlete.id }), NOT
// 'athleteId' (see the report). Both original files independently read
// this from their own `new URLSearchParams(location.search).get('id')` -
// now it's one value shared by both halves of this module.
let athleteId = null

// Most recently loaded athletes row - read by the status badge, the invite
// actions, the edit-info modal's prefill, and the PDF report's header
let currentAthlete = null

// ==========================================================================
// ---- OVERVIEW: refresh guard ----
// This tab otherwise only loads stats once, on open - a coach watching an
// athlete log a workout live (in another tab, or on their phone) would
// never see it update without a manual reload. The Refresh button covers
// "check right now"; the visibilitychange listener (wired in mount(),
// removed in unmount()) covers "I switched back to this tab" - same pattern
// used athlete-side (athlete-app/dashboard.js), just applied here to this
// screen instead of a whole page.
//
// Both are guarded: overviewLoadInFlight stops an overlapping call from
// firing a second, competing round of the same 3 queries (the exact
// mistake that caused the athlete-side statement-timeout bug this session -
// same fix, preserved exactly as athlete.js had it). lastOverviewAutoRefresh
// additionally throttles the visibilitychange trigger specifically -
// flipping back and forth to another tab (e.g. the Supabase SQL editor)
// shouldn't re-fire this page's stats every single time. The Refresh button
// ignores that cooldown - tapping it is explicit intent and should always
// work immediately.
let overviewLoadInFlight = false
let lastOverviewAutoRefresh = 0
let onVisibilityChange = null // tracked so unmount() can remove it

// ==========================================================================
// ---- METRICS state ----
// ==========================================================================
let currentMetric = null
let allMetrics = []
let athleteMetrics = []
let prEvents = [] // PRs broken in the last 30 days, filled in by loadStatsBar, read by the PR overview modal
let allMeasurementsCache = [] // every measurement for this athlete, filled in by loadStatsBar, read by the stats-bar detail modals
let metricsLoaded = false // Metrics tab loads its data lazily - see bindTabs()

// ---- Overview stats (loadOverviewStats fills these in; read by the
// duration/volume/4 training-load detail modals) ----
let volumeChart = null
let volumeChartData = { labels: [], values: [] }
let durationEvents = [] // { dateStr, name, minutes }
let last7DailyLoad = [] // { dateStr, load }, oldest first
let acuteLoadValue = 0
let chronicLoadValue = 0
let acwrValue = null
let monotonyValue = null
let strainValue = null
let daysOfLoadHistoryValue = 0 // how many days back the earliest rated session goes

// ---- PDF Progress Report - filled in fresh every time the Report Builder
// modal opens (no saved template) ----
let reportDataCache = null
let reportSelectedSections = new Set()
let reportSelectedMonths = 3

// ---- Athlete Notes ----
let currentNoteEntry = null

// ---- Graph Modal ----
let fullChart = null
let currentGraphMetric = null
let currentGraphMonths = 1 // remembers the active time filter, so the bodyweight toggle can redraw without needing it passed in again
let showBodyweightOverlay = false

// ---- Entries Modal ----
let currentEditEntry = null
let currentEntriesMetric = null

// ---- Last Updated modal pagination ----
let recentActivityPage = 0

// ---- Bodyweight ----
let bodyweightChart = null
let bodyweightUnit = 'kg'
let currentBWEntry = null

// ---- Toast (see showToast()) ----
let toastHideTimer = null

// Chart.js instances for the per-metric mini graphs in renderMetrics(). The
// originals never stored these - each metric-item's canvas is thrown away
// and rebuilt every time renderMetrics() reruns, and on the multi-page site
// the whole document (and every Chart instance pointed at it) went away on
// the next navigation regardless. Here the screen can be torn down without
// a full page reload, so these are tracked and destroyed in unmount() -
// same reasoning as the timers/listeners below, just for Chart.js instances
// instead.
let miniChartInstances = []

// ==========================================================================
// ---- CALENDAR TAB state ----
// ==========================================================================
let calendarEntriesByDate = {} // 'YYYY-MM-DD' -> array of { program, week, day }
let sessionByDayId = {} // program_days.id -> the workout_sessions row to show (in-progress wins over done, done wins over older done), absent = not started yet
let logSetsByPECal = {} // program_exercise_id -> array of exercise_log_sets rows, sorted by set_number
let mobilityEntriesByDateCal = {} // 'YYYY-MM-DD' -> workout_sessions row with session_type='mobility'
let tournamentsByDateCal = {} // 'YYYY-MM-DD' -> tournaments row (athlete-added, read-only here)
let formAssignmentsByDateCal = {} // 'YYYY-MM-DD' -> array of form_assignments rows (joined with forms(name, gate_workout))
let calendarLoaded = false
let currentDayDateForModal = null // date currently shown in the day-detail modal

// currentViewYear/currentViewMonth used to be seeded from a module-level
// `const today = new Date()` - correct on the multi-page site, where the
// whole script re-ran (and re-read "today") on every visit, but wrong here:
// this module is imported once and its top-level code runs exactly once for
// the life of the app session, so a `const` here would freeze the calendar
// on whatever date the coach's session happened to start, even days later.
// Seeded fresh in mount() instead (and cleared in unmount()) so every visit
// to this screen opens on the real current month.
let currentViewYear = null
let currentViewMonth = null

let currentDayDateForAddTraining = null // remembered so "+ New Training" can come back to the same day's popup afterward

// Which ad-hoc day findOrCreateAdHocDay should reuse, scoped to THIS popup
// session only - see findOrCreateAdHocDay's own comment below
let adHocDayIdForThisSession = null
let adHocDayDateForThisSession = null

// Cached lists, cleared in unmount() rather than left to outlive the screen
let cachedTrainings = null
let cachedTemplates = null
let selectedTrainingId = null
let selectedTrainingName = null
let cachedTrainingExercises = {} // training_id -> exercises array
let selectedTemplateId = null
let selectedTemplateName = null
let totalProgramDays = 1
let programStartDay = 1
let programEndDay = 1
let cachedTemplateDays = {} // template_id -> { days, totalWeeks }
let dayPickerTarget = null // 'start' | 'end'
let dayPickerPage = 0

// ---- Arm-and-drop copying ----
let copyArmedMode = null // 'week' | 'workout' | null
let copyArmedSourceDayId = null
let copyArmedSourceName = null
let copyArmedSourceMonday = null
let copyArmedHoverKey = null

// ---- Drag-to-reorder within a day's exercise list ----
let draggingCardsCal = []
let draggingGroupCal = null

// ---- Autosave timers, one per program_exercise id being edited ----
let autosaveTimersCal = {}

// ---- Supersets ----
let pickingGroupIdsCal = null // array being built while picking, else null

// ---- Section tab ----
let cachedSectionsCal = null
let selectedSectionIdCal = null
let selectedSectionNameCal = null
let cachedSectionExercisesCal = {}

// ---- Form tab ----
let cachedFormsCal = null
let selectedFormIdCal = null
let selectedFormNameCal = null
let cachedFormQuestionsCal = {}

// 'new-training': building a fresh Workout Library entry from the day-add
// popup's "+ New" - Done goes back to that popup so the new one can be
// selected. 'edit-day': adjusting an already-scheduled day's exercises
// straight from its own calendar badge - Done just closes and refreshes
// the month, there's no popup to return to.
let trainingBuilderOverlayMode = 'new-training'

// Document-level listeners - the SPA-leak risk this screen is most exposed
// to given its size. All three tracked here and removed in unmount().
let onDocClickKebabCal = null // outside click closes calendar kebab dropdowns
let onDocKeydownCal = null // Escape disarms an in-progress calendar copy

// ==========================================================================
// ---- MOUNT / UNMOUNT ----
// ==========================================================================
export async function mount(container, params, token) {
  ensureCss('css/athlete-detail.css?v=1')
  root = container
  mountToken = token
  athleteId = params.id
  container.innerHTML = SKELETON
  root.querySelector('#athleteDetailBackBtn').addEventListener('click', function() { nav.back() })

  const now = new Date()
  currentViewYear = now.getFullYear()
  currentViewMonth = now.getMonth()

  const ok = await loadAthlete(token)
  if (!nav.isCurrent(token)) return
  if (!ok) return

  container.innerHTML = TEMPLATE
  // TEMPLATE's own back button is a fresh DOM node - the listener attached
  // to SKELETON's button above didn't carry over, it was destroyed along
  // with the rest of SKELETON's markup by the innerHTML replacement above.
  // Without this, "← Back" would be silently dead on every athlete screen
  // that finished loading (the skeleton and the error-state screen further
  // below both wire their own copy of this button already).
  root.querySelector('#athleteDetailBackBtn').addEventListener('click', function() { nav.back() })
  bindEvents()
  bindTabs()
  paintAthleteHeader()

  // Overview tab is visible by default, so its data loads right away.
  // Metrics/Calendar tabs load lazily when first clicked - see bindTabs().
  loadLatestNote()
  loadBodyweightGraph()
  loadOverviewStats()
  loadRecentActivity()

  onVisibilityChange = function() {
    if (document.visibilityState !== 'visible' || !athleteId) return
    if (Date.now() - lastOverviewAutoRefresh < 15000) return
    lastOverviewAutoRefresh = Date.now()
    loadOverviewStatsGuarded()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  // Calendar tab's outside-click (closes its kebab dropdowns) and
  // Escape-to-disarm-copy - both document-level in athlete-calendar.js,
  // registered unconditionally there too (the elements they look for don't
  // exist until the Calendar tab has been opened at least once, so these
  // are harmless no-ops until then, exactly like on the original page).
  onDocClickKebabCal = function(e) {
    if (e.target.closest('.kebab-menu')) return
    root?.querySelectorAll('#calendarGrid .kebab-dropdown.active').forEach(d => d.classList.remove('active'))
  }
  document.addEventListener('click', onDocClickKebabCal)

  onDocKeydownCal = function(e) {
    if (e.key === 'Escape' && copyArmedMode) disarmCopy()
  }
  document.addEventListener('keydown', onDocKeydownCal)
}

export function unmount() {
  if (onVisibilityChange) document.removeEventListener('visibilitychange', onVisibilityChange)
  if (onDocClickKebabCal) document.removeEventListener('click', onDocClickKebabCal)
  if (onDocKeydownCal) document.removeEventListener('keydown', onDocKeydownCal)
  onVisibilityChange = null
  onDocClickKebabCal = null
  onDocKeydownCal = null

  clearTimeout(toastHideTimer)
  toastHideTimer = null
  Object.values(autosaveTimersCal).forEach(clearTimeout)
  autosaveTimersCal = {}

  if (bodyweightChart) { bodyweightChart.destroy(); bodyweightChart = null }
  if (volumeChart) { volumeChart.destroy(); volumeChart = null }
  if (fullChart) { fullChart.destroy(); fullChart = null }
  miniChartInstances.forEach(function(c) { c.destroy() })
  miniChartInstances = []

  root = null
  mountToken = null
  athleteId = null
  currentAthlete = null

  overviewLoadInFlight = false
  lastOverviewAutoRefresh = 0

  currentMetric = null
  allMetrics = []
  athleteMetrics = []
  prEvents = []
  allMeasurementsCache = []
  metricsLoaded = false

  volumeChartData = { labels: [], values: [] }
  durationEvents = []
  last7DailyLoad = []
  acuteLoadValue = 0
  chronicLoadValue = 0
  acwrValue = null
  monotonyValue = null
  strainValue = null
  daysOfLoadHistoryValue = 0

  reportDataCache = null
  reportSelectedSections = new Set()
  reportSelectedMonths = 3

  currentNoteEntry = null

  currentGraphMetric = null
  currentGraphMonths = 1
  showBodyweightOverlay = false

  currentEditEntry = null
  currentEntriesMetric = null

  recentActivityPage = 0

  bodyweightUnit = 'kg'
  currentBWEntry = null

  calendarEntriesByDate = {}
  sessionByDayId = {}
  logSetsByPECal = {}
  mobilityEntriesByDateCal = {}
  tournamentsByDateCal = {}
  formAssignmentsByDateCal = {}
  calendarLoaded = false
  currentDayDateForModal = null
  currentViewYear = null
  currentViewMonth = null

  currentDayDateForAddTraining = null
  adHocDayIdForThisSession = null
  adHocDayDateForThisSession = null
  cachedTrainings = null
  cachedTemplates = null
  selectedTrainingId = null
  selectedTrainingName = null
  cachedTrainingExercises = {}
  selectedTemplateId = null
  selectedTemplateName = null
  totalProgramDays = 1
  programStartDay = 1
  programEndDay = 1
  cachedTemplateDays = {}
  dayPickerTarget = null
  dayPickerPage = 0

  copyArmedMode = null
  copyArmedSourceDayId = null
  copyArmedSourceName = null
  copyArmedSourceMonday = null
  copyArmedHoverKey = null

  draggingCardsCal = []
  draggingGroupCal = null

  pickingGroupIdsCal = null

  cachedSectionsCal = null
  selectedSectionIdCal = null
  selectedSectionNameCal = null
  cachedSectionExercisesCal = {}

  cachedFormsCal = null
  selectedFormIdCal = null
  selectedFormNameCal = null
  cachedFormQuestionsCal = {}

  trainingBuilderOverlayMode = 'new-training'
}

// ==========================================================================
// ---- EVENT WIRING ----
// Everything the two original files registered at module top-level (against
// markup that was already in the document) or inside loadAthlete()/
// loadCalendarMonth() closures. Called once per mount, after TEMPLATE is in.
// Grouped into the same sections the originals used - see each section's
// own banner further down for the render/data logic these buttons call into.
// ==========================================================================
function bindEvents() {
  bindOverviewEvents()
  bindSettingsEvents()
  bindStatusInviteEvents()
  bindNotesEvents()
  bindMetricsStaticEvents()
  bindGraphModalEvents()
  bindReportEvents()
  bindChangeExplainEvents()
  bindEditAthleteEvents()
  bindBodyweightEvents()
  bindCalendarStaticEvents()
}

// ==========================================================================
// ---- TABS ----
// Switches which .tab-panel is visible. Metrics/Calendar data loads lazily,
// the first time that tab is clicked, not on mount - Chart.js sizes its
// canvases from their rendered pixel dimensions, so drawing graphs while a
// panel is still display:none would produce blank/squashed charts.
// ==========================================================================
function bindTabs() {
  root.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      root.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
      root.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'))
      btn.classList.add('active')
      root.querySelector('#tab-' + btn.dataset.tab).classList.add('active')

      if (btn.dataset.tab === 'metrics' && !metricsLoaded) {
        metricsLoaded = true
        const token = mountToken
        loadAllMetrics().then(function() {
          if (!nav.isCurrent(token)) return
          return loadAthleteMetrics()
        })
      }

      if (btn.dataset.tab === 'calendar') {
        activateCalendarTab()
      }
    })
  })
}

// Was a CustomEvent round trip (window.dispatchEvent/addEventListener)
// between the two original files, since they had no shared scope to call
// into each other with directly. Now that they're one module this is just a
// plain function call from bindTabs() above - simpler, and removes what
// would otherwise be a `window`-level listener living for the life of the
// app (a real SPA leak candidate, worse than the document-level ones this
// screen already has to track, since window listeners are even easier to
// forget).
function activateCalendarTab() {
  if (calendarLoaded) return
  calendarLoaded = true
  const token = mountToken
  loadCalendarMonth(currentViewYear, currentViewMonth)
  // #calendarGrid itself is a persistent node (only its innerHTML gets
  // replaced on every month change) - delegated listeners are wired here,
  // once, rather than inside renderCalendarGrid (which reruns on every
  // month load and would otherwise stack a new set of listeners each time)
  wireCalendarDragToMove(root.querySelector('#calendarGrid'))
  wireCalendarCopyArming(root.querySelector('#calendarGrid'))
  wireCalendarBadgeKebabs(root.querySelector('#calendarGrid'))
}

// ==========================================================================
// ---- CALENDAR TAB: DATE HELPERS ----
// Same timezone-safe parsing convention as formatDisplayDate() in the
// Overview/Notes half (new Date(dateStr + 'T00:00:00')) - building
// YYYY-MM-DD strings by hand rather than via .toISOString(), which
// re-introduces an off-by-one bug for local dates.
// ==========================================================================
function toDateStr(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function parseDateStr(dateStr) {
  return new Date(dateStr + 'T00:00:00')
}

function formatDisplayDateCal(dateStr) {
  return parseDateStr(dateStr).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
}

function formatShortDateCal(dateStr) {
  return parseDateStr(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// tracks_weight/is_timed/is_unilateral/tracks_distance normally come
// straight from the exercise's own row (row.exercises) - an explicit
// *_override on THIS training_exercises/program_exercises row (set via
// Workout Builder's "Adjust Fields") takes precedence instead, scoped to
// just that one workout. Merging the override into row.exercises here,
// once per fetch, means every existing read of row.exercises.* downstream
// sees the right effective value with no other changes needed.
function applyFieldOverridesCal(row) {
  if (!row.exercises) return
  if (row.tracks_weight_override != null) row.exercises.tracks_weight = row.tracks_weight_override
  if (row.is_timed_override != null) row.exercises.is_timed = row.is_timed_override
  if (row.is_unilateral_override != null) row.exercises.is_unilateral = row.is_unilateral_override
  if (row.tracks_distance_override != null) row.exercises.tracks_distance = row.tracks_distance_override
}

// All the calendar-day dates a tournament covers, inclusive of both ends -
// a single-day tournament (date === end_date) is just a one-element range
function eachDateStrInRangeCal(startStr, endStr) {
  const dates = []
  const cursor = parseDateStr(startStr)
  while (toDateStr(cursor) <= endStr) {
    dates.push(toDateStr(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return dates
}

function resolveDate(startDateStr, weekNumber, dayNumber) {
  const start = parseDateStr(startDateStr)
  const result = new Date(start)
  result.setDate(result.getDate() + (weekNumber - 1) * 7 + (dayNumber - 1))
  return toDateStr(result)
}

const WORKOUT_TYPE_LABELS_CAL = { gym: 'Gym', field: 'Field', run: 'Run' }

function trainingDisplayName(entry) {
  if (entry.program.is_adhoc) return entry.program.name || 'Training'
  return entry.day.label || ('Day ' + entry.day.day_number)
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// Same 1-5 scale/anchors as TOURNAMENT_IMPORTANCE_DESCRIPTIONS in the
// athlete app's dashboard.js (where the athlete actually picks the
// rating) - duplicated here since this is coach-only, read-only display
// of the same tournaments table.
const TOURNAMENT_IMPORTANCE_DESCRIPTIONS_CAL = {
  1: 'Not important at all - just for fun or experience',
  2: 'Low priority - a tune-up event',
  3: 'Moderately important - worth some focused prep',
  4: 'Important - a key event this season',
  5: 'Most important tournament of the year - tapering needed'
}

// ==========================================================================
// ---- LOAD + RENDER MONTH GRID ----
// ==========================================================================
async function loadCalendarMonth(year, month) {
  const token = mountToken
  root.querySelector('#calMonthLabel').textContent = `${MONTH_NAMES[month]} ${year}`

  // Programs, sessions, and logged sets don't depend on each other, so they fire together
  const [
    { data, error },
    { data: sessions, error: sessionsError },
    { data: logSets, error: logSetsError },
    { data: tournaments, error: tournamentsError },
    { data: formAssignments, error: formAssignmentsError }
  ] = await Promise.all([
    window.fetchWithRetry((signal) => supabase
      .from('programs')
      .select('*, program_weeks(*, program_days(*, program_exercises(*, exercises!exercise_id(name, category, type, video_url, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance))))')
      .eq('athlete_id', athleteId)
      .eq('is_template', false)
      .abortSignal(signal)
    ),
    window.fetchWithRetry((signal) => supabase
      .from('workout_sessions')
      .select('id, program_day_id, started_at, ended_at, local_date, session_rpe, session_type, rpe_flag_reason, rpe_flag_note, rpe_flag_reviewed_at, mobility_focus_areas')
      .eq('athlete_id', athleteId)
      .abortSignal(signal)
    ),
    window.fetchWithRetry((signal) => supabase
      .from('exercise_log_sets')
      .select('*')
      .eq('athlete_id', athleteId)
      .abortSignal(signal)
    ),
    window.fetchWithRetry((signal) => supabase
      .from('tournaments')
      .select('*')
      .eq('athlete_id', athleteId)
      .abortSignal(signal)
    ),
    window.fetchWithRetry((signal) => supabase
      .from('form_assignments')
      .select('*, forms(name, gate_workout), form_answers(id)')
      .eq('athlete_id', athleteId)
      .abortSignal(signal), 1
    )
  ])

  if (!nav.isCurrent(token)) return

  if (error) { console.log('Error loading calendar:', error); customAlert('Something went wrong loading the calendar - check your connection and try again'); return }
  if (sessionsError) { console.log('Error loading sessions for calendar:', sessionsError) }
  if (logSetsError) { console.log('Error loading logged sets for calendar:', logSetsError) }
  if (tournamentsError) { console.log('Error loading tournaments for calendar:', tournamentsError) }
  if (formAssignmentsError) { console.log('Error loading form assignments for calendar:', formAssignmentsError) }

  tournamentsByDateCal = {}
  for (const t of tournaments || []) {
    for (const dateStr of eachDateStrInRangeCal(t.date, t.end_date)) tournamentsByDateCal[dateStr] = t
  }

  formAssignmentsByDateCal = {}
  for (const fa of formAssignments || []) {
    (formAssignmentsByDateCal[fa.date] ||= []).push(fa)
  }

  calendarEntriesByDate = {}
  for (const program of data) {
    for (const week of program.program_weeks) {
      for (const day of week.program_days) {
        day.program_exercises.forEach(applyFieldOverridesCal)
        const dateStr = day.date_override || resolveDate(program.start_date, week.week_number, day.day_number)
        if (!calendarEntriesByDate[dateStr]) calendarEntriesByDate[dateStr] = []
        calendarEntriesByDate[dateStr].push({ program, week, day })
      }
    }
  }

  // A day can in theory have more than one session (e.g. the athlete started
  // it, it got abandoned, and they started again later) - in-progress always
  // wins if any session is still open, otherwise the most recently ended one
  // decides "done"
  sessionByDayId = {}
  mobilityEntriesByDateCal = {}
  for (const s of sessions || []) {
    if (s.session_type === 'mobility') {
      mobilityEntriesByDateCal[s.local_date] = s
      continue
    }
    if (!s.ended_at) {
      sessionByDayId[s.program_day_id] = s
      continue
    }
    const existing = sessionByDayId[s.program_day_id]
    if (existing && !existing.ended_at) continue
    if (!existing || new Date(s.ended_at) > new Date(existing.ended_at)) {
      sessionByDayId[s.program_day_id] = s
    }
  }

  logSetsByPECal = {}
  for (const row of logSets || []) {
    if (!logSetsByPECal[row.program_exercise_id]) logSetsByPECal[row.program_exercise_id] = []
    logSetsByPECal[row.program_exercise_id].push(row)
  }
  for (const peId in logSetsByPECal) {
    logSetsByPECal[peId].sort((a, b) => a.set_number - b.set_number)
  }

  renderCalendarGrid(year, month)
}

function renderCalendarGrid(year, month) {
  const grid = root.querySelector('#calendarGrid')
  // getDay() is 0=Sun..6=Sat - remapped so the grid's rows start on Monday
  // instead (0=Mon..6=Sun), matching the athlete's own week view
  const startWeekday = (new Date(year, month, 1).getDay() + 6) % 7
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const prevMonthDays = new Date(year, month, 0).getDate()

  const cells = []
  for (let i = startWeekday - 1; i >= 0; i--) {
    cells.push({ date: new Date(year, month - 1, prevMonthDays - i), outside: true })
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(year, month, d), outside: false })
  }
  let nextMonthDay = 1
  while (cells.length < 42) {
    cells.push({ date: new Date(year, month + 1, nextMonthDay), outside: true })
    nextMonthDay++
  }

  const todayStr = toDateStr(new Date())

  let html = ''
  cells.forEach((cell, i) => {
    // Rows always start on Monday (see startWeekday above), so the row's
    // own first cell IS that week's Monday - one small copy icon per row,
    // in its own gutter column to the left of the 7 day columns (see the
    // #calendarGrid/#calendarWeekdayHeader grid-template-columns overrides
    // in app.css). Clicking it arms week-copy, see wireCalendarCopyArming.
    if (i % 7 === 0) {
      const weekMonday = toDateStr(cell.date)
      html += `<div class="calendar-week-gutter-cell"><button type="button" class="calendar-week-copy-btn" data-action="arm-copy-week" data-week-monday="${weekMonday}" title="Copy this week">⧉</button></div>`
    }
    const weekMonday = toDateStr(cells[i - (i % 7)].date)
    html += renderCalendarDayCell(cell, weekMonday, todayStr)
  })
  grid.innerHTML = html

  // The cell background itself is not clickable - with two workouts back
  // to back it was never clear which one you'd land on. Only a specific
  // badge/dot opens anything (see wireCalendarBadgeKebabs' view-workout/
  // view-mobility/view-tournament handling below).
  grid.querySelectorAll('.calendar-day-add-btn').forEach(btn => {
    btn.addEventListener('click', function(e) {
      e.stopPropagation()
      adHocDayIdForThisSession = null
      adHocDayDateForThisSession = null
      openDayAddTrainingModal(btn.dataset.date)
    })
  })
}

function renderCalendarDayCell(cell, weekMonday, todayStr) {
    const dateStr = toDateStr(cell.date)
    const entries = calendarEntriesByDate[dateStr] || []
    // One badge per training (keyed by day.id, always unique - two different
    // trainings that happen to share a display name used to incorrectly
    // collapse into one badge here). Color shows where it's at: blue for
    // planned (no session yet), orange while the athlete's in the middle of
    // it, green once they've finished it.
    const badges = [...new Map(entries.map(entry => [entry.day.id, entry])).values()]
    const mobility = mobilityEntriesByDateCal[dateStr]
    const tournament = tournamentsByDateCal[dateStr]

    const classes = ['calendar-day']
    if (cell.outside) classes.push('calendar-day-outside')
    if (dateStr === todayStr) classes.push('calendar-day-today')

    // One shared list of "what's on this day", rendered two ways: small
    // fixed-size dots (phone-width screens - a busy day used to blow the
    // cell's height or width out showing one full-name badge per item, see
    // git history) and full-name badges (desktop, where a column is wide
    // enough that showing real names is more useful than a dot). CSS picks
    // which one is visible per viewport width - see .calendar-day-dots/
    // .calendar-day-badges in app.css. Clicking a specific badge/dot opens
    // that ONE item's own detail modal (view-workout/view-mobility/
    // view-tournament, see wireCalendarBadgeKebabs) - the day cell's blank
    // background does nothing.
    const items = badges.map(entry => {
      const session = sessionByDayId[entry.day.id]
      const status = session ? (session.ended_at ? 'done' : 'in-progress') : 'planned'
      const glyph = status === 'done' ? '✓' : (status === 'in-progress' ? '▶' : '')
      // dayId marks this as a real, draggable workout with its own kebab
      // menu (copy/delete, see the badgesHtml build below) - tournament
      // items never get one (nothing to delete/copy from the calendar),
      // mobility gets a delete-only kebab (see mobilitySessionId below)
      // Small colored dot (not part of the escaped label text, since it's
      // real markup) - status is already the badge's background color, so
      // type gets its own separate marker instead of competing for it
      const typeDot = entry.day.workout_type ? `<span class="workout-type-dot workout-type-dot-${entry.day.workout_type}"></span>` : ''
      return { status, glyph, typeDot, label: trainingDisplayName(entry), dayId: entry.day.id, programId: entry.program.id, isAdhoc: entry.program.is_adhoc }
    })
    if (mobility) items.push({ status: 'mobility', glyph: '', label: 'Mobility', mobilitySessionId: mobility.id })
    if (tournament) items.push({ status: 'tournament', glyph: '', label: tournament.name, importance: tournament.importance })
    for (const fa of (formAssignmentsByDateCal[dateStr] || [])) {
      items.push({ status: fa.completed_at ? 'done' : 'form', glyph: fa.completed_at ? '✓' : '', label: (fa.forms ? fa.forms.name : 'Form'), formAssignmentId: fa.id })
    }

    const visibleItems = items.slice(0, 4)
    const extraCount = items.length - visibleItems.length
    // Real workouts (dayId set) get copy+delete, mobility (mobilitySessionId
    // set) gets delete only - no "copy" makes sense for a logged mobility
    // session - and tournament/"+N more" stay plain with no menu at all.
    // Dots (mobile) trigger the same kebab by tapping the dot itself, since
    // there's no room for a separate ⋮ button at this size - see
    // wireCalendarBadgeKebabs, which handles any [data-action] element
    // generically so this needed no JS changes beyond the markup.
    const dotsHtml = visibleItems.map(it => {
      if (it.dayId) {
        const deleteAttrs = it.isAdhoc
          ? `data-mode="adhoc" data-program-id="${it.programId}"`
          : `data-mode="day" data-program-day-id="${it.dayId}"`
        return `
          <div class="kebab-menu calendar-dot-kebab">
            <span class="calendar-day-dot calendar-day-dot-${it.status}" data-action="toggle-kebab">${it.glyph}</span>
            <div class="kebab-dropdown">
              <button type="button" class="kebab-item" data-action="view-workout" data-program-day-id="${it.dayId}" data-date="${dateStr}">View Workout</button>
              <button type="button" class="kebab-item" data-action="copy-training" data-program-day-id="${it.dayId}" data-name="${escapeHtmlCal(it.label)}">Copy to another day</button>
              <button type="button" class="kebab-item" data-action="delete-training" ${deleteAttrs}>Delete Workout</button>
            </div>
          </div>
        `
      }
      if (it.mobilitySessionId) {
        return `
          <div class="kebab-menu calendar-dot-kebab">
            <span class="calendar-day-dot calendar-day-dot-${it.status}" data-action="toggle-kebab">${it.glyph}</span>
            <div class="kebab-dropdown">
              <button type="button" class="kebab-item" data-action="view-mobility" data-date="${dateStr}">View Mobility</button>
              <button type="button" class="kebab-item" data-action="delete-mobility" data-session-id="${it.mobilitySessionId}">Delete Mobility Session</button>
            </div>
          </div>
        `
      }
      if (it.formAssignmentId) {
        return `
          <div class="kebab-menu calendar-dot-kebab">
            <span class="calendar-day-dot calendar-day-dot-${it.status}" data-action="toggle-kebab">${it.glyph}</span>
            <div class="kebab-dropdown">
              <button type="button" class="kebab-item" data-action="view-form" data-assignment-id="${it.formAssignmentId}">View Form</button>
              <button type="button" class="kebab-item" data-action="delete-form" data-assignment-id="${it.formAssignmentId}">Delete Form</button>
            </div>
          </div>
        `
      }
      return `<span class="calendar-day-dot calendar-day-dot-${it.status}" data-action="view-tournament" data-date="${dateStr}" title="Importance ${it.importance}/5">${it.importance != null ? it.importance : it.glyph}</span>`
    }).join('')
      + (extraCount > 0 ? `<span class="calendar-day-dot calendar-day-dot-more">+${extraCount}</span>` : '')
    const badgesHtml = visibleItems.map(it => {
      if (it.dayId) {
        const deleteAttrs = it.isAdhoc
          ? `data-mode="adhoc" data-program-id="${it.programId}"`
          : `data-mode="day" data-program-day-id="${it.dayId}"`
        return `
          <div class="calendar-day-badge-row">
            <span class="calendar-day-badge calendar-day-badge-${it.status}" draggable="true" data-day-id="${it.dayId}" data-action="view-workout" data-date="${dateStr}">${it.typeDot || ''}${it.glyph ? it.glyph + ' ' : ''}${escapeHtmlCal(it.label)}</span>
            <div class="kebab-menu calendar-badge-kebab">
              <button type="button" class="kebab-btn" data-action="toggle-kebab">⋮</button>
              <div class="kebab-dropdown">
                <button type="button" class="kebab-item" data-action="copy-training" data-program-day-id="${it.dayId}" data-name="${escapeHtmlCal(it.label)}">Copy to another day</button>
                <button type="button" class="kebab-item" data-action="delete-training" ${deleteAttrs}>Delete Workout</button>
              </div>
            </div>
          </div>
        `
      }
      if (it.mobilitySessionId) {
        return `
          <div class="calendar-day-badge-row">
            <span class="calendar-day-badge calendar-day-badge-${it.status}" data-action="view-mobility" data-date="${dateStr}">${escapeHtmlCal(it.label)}</span>
            <div class="kebab-menu calendar-badge-kebab">
              <button type="button" class="kebab-btn" data-action="toggle-kebab">⋮</button>
              <div class="kebab-dropdown">
                <button type="button" class="kebab-item" data-action="delete-mobility" data-session-id="${it.mobilitySessionId}">Delete Mobility Session</button>
              </div>
            </div>
          </div>
        `
      }
      if (it.formAssignmentId) {
        return `
          <div class="calendar-day-badge-row">
            <span class="calendar-day-badge calendar-day-badge-${it.status}" data-action="view-form" data-assignment-id="${it.formAssignmentId}">${it.glyph ? it.glyph + ' ' : ''}${escapeHtmlCal(it.label)}</span>
            <div class="kebab-menu calendar-badge-kebab">
              <button type="button" class="kebab-btn" data-action="toggle-kebab">⋮</button>
              <div class="kebab-dropdown">
                <button type="button" class="kebab-item" data-action="delete-form" data-assignment-id="${it.formAssignmentId}">Delete Form</button>
              </div>
            </div>
          </div>
        `
      }
      return `<span class="calendar-day-badge calendar-day-badge-${it.status}" data-action="view-tournament" data-date="${dateStr}" title="Importance ${it.importance}/5">${it.importance != null ? `★${it.importance} ` : ''}${it.typeDot || ''}${it.glyph ? it.glyph + ' ' : ''}${escapeHtmlCal(it.label)}</span>`
    }).join('')
      + (extraCount > 0 ? `<span class="calendar-day-badge calendar-day-badge-more">+${extraCount} more</span>` : '')

    return `
      <div class="${classes.join(' ')}" data-date="${dateStr}" data-week-monday="${weekMonday}">
        <button type="button" class="calendar-day-add-btn" data-date="${dateStr}">+</button>
        <span class="calendar-day-number">${cell.date.getDate()}</span>
        <div class="calendar-day-dots">${dotsHtml}</div>
        <div class="calendar-day-badges">${badgesHtml}</div>
      </div>
    `
}

// ==========================================================================
// ---- DRAG A WORKOUT BADGE TO A NEW DAY ----
// Desktop-only in practice - only .calendar-day-badge (hidden on mobile in
// favor of the tiny dots) carries draggable="true", and only for real
// workouts (mobility/tournament items never get a data-day-id, see
// renderCalendarGrid's items build). Wired once on the persistent
// #calendarGrid node itself (see activateCalendarTab), rather than
// per-render, since delegated listeners on a node whose children get
// replaced don't need re-attaching.
// ==========================================================================
function wireCalendarDragToMove(grid) {
  grid.addEventListener('dragstart', function(e) {
    const badge = e.target.closest('.calendar-day-badge[draggable="true"]')
    if (!badge) return
    e.dataTransfer.setData('text/plain', badge.dataset.dayId)
    e.dataTransfer.effectAllowed = 'move'
    setTimeout(() => badge.classList.add('dragging'), 0)
  })
  grid.addEventListener('dragend', function(e) {
    const badge = e.target.closest('.calendar-day-badge')
    if (badge) badge.classList.remove('dragging')
  })
  grid.addEventListener('dragover', function(e) {
    const cell = e.target.closest('.calendar-day')
    if (!cell) return
    e.preventDefault()
    cell.classList.add('drag-over')
  })
  grid.addEventListener('dragleave', function(e) {
    const cell = e.target.closest('.calendar-day')
    if (cell) cell.classList.remove('drag-over')
  })
  grid.addEventListener('drop', async function(e) {
    const cell = e.target.closest('.calendar-day')
    if (!cell) return
    e.preventDefault()
    cell.classList.remove('drag-over')
    const dayId = e.dataTransfer.getData('text/plain')
    if (!dayId) return
    await moveWorkoutToDate(dayId, cell.dataset.date)
  })
}

async function moveWorkoutToDate(dayId, newDateStr) {
  const token = mountToken
  const { error } = await supabase.from('program_days').update({ date_override: newDateStr }).eq('id', dayId)
  if (!nav.isCurrent(token)) return
  if (error) { console.log(error); customAlert('Something went wrong moving that workout'); return }
  await loadCalendarMonth(currentViewYear, currentViewMonth)
}

// ==========================================================================
// ---- PER-BADGE/DOT ACTIONS ON THE CALENDAR GRID (view / copy / delete) ----
// View/Copy/Delete for a workout live right on its badge (desktop) or dot
// (mobile) in the month view - a coach scanning the calendar can act on a
// specific workout without first opening a combined popup for the whole
// day. Wired once on the persistent #calendarGrid node, same reasoning as
// wireCalendarDragToMove.
//
// Registered on the CAPTURE phase (the trailing `true`) so a toggle-kebab
// tap (which stopPropagation()s here) can never also register as, say, a
// drag start on the same element.
// ==========================================================================
function wireCalendarBadgeKebabs(grid) {
  grid.addEventListener('click', function(e) {
    const btn = e.target.closest('[data-action]')
    if (!btn) return

    if (btn.dataset.action === 'toggle-kebab') {
      e.stopPropagation()
      const dropdown = btn.parentElement.querySelector('.kebab-dropdown')
      const wasActive = dropdown.classList.contains('active')
      root.querySelectorAll('#calendarGrid .kebab-dropdown.active').forEach(d => d.classList.remove('active'))
      if (!wasActive) dropdown.classList.add('active')
      return
    }

    if (btn.dataset.action === 'view-workout') {
      e.stopPropagation()
      if (btn.closest('.kebab-dropdown')) btn.closest('.kebab-dropdown').classList.remove('active')
      openWorkoutDetailModal(btn.dataset.date, btn.dataset.dayId || btn.dataset.programDayId)
      return
    }

    if (btn.dataset.action === 'view-mobility') {
      e.stopPropagation()
      if (btn.closest('.kebab-dropdown')) btn.closest('.kebab-dropdown').classList.remove('active')
      openMobilityDetailModal(btn.dataset.date)
      return
    }

    if (btn.dataset.action === 'view-tournament') {
      e.stopPropagation()
      openTournamentDetailModal(btn.dataset.date)
      return
    }

    if (btn.dataset.action === 'view-form') {
      e.stopPropagation()
      if (btn.closest('.kebab-dropdown')) btn.closest('.kebab-dropdown').classList.remove('active')
      openFormDetailModal(btn.dataset.assignmentId)
      return
    }

    if (btn.dataset.action === 'copy-training') {
      e.stopPropagation()
      btn.closest('.kebab-dropdown').classList.remove('active')
      armCopyWorkout(btn.dataset.programDayId, btn.dataset.name)
      return
    }

    if (btn.dataset.action === 'delete-training') {
      e.stopPropagation()
      deleteTraining(btn.dataset.mode, btn.dataset.programId, btn.dataset.programDayId)
      return
    }

    if (btn.dataset.action === 'delete-mobility') {
      e.stopPropagation()
      deleteMobilitySession(btn.dataset.sessionId)
      return
    }

    if (btn.dataset.action === 'delete-form') {
      e.stopPropagation()
      deleteFormAssignment(btn.dataset.assignmentId)
      return
    }
  }, true)
}

// ==========================================================================
// ---- DAY DETAIL MODAL ----
// Reads straight from the in-memory calendarEntriesByDate/mobilityEntries
// ByDateCal/tournamentsByDateCal maps - no query. Opened per-ITEM now, not
// per-day - a day with two workouts back to back used to dump both into one
// scrolling popup with no clear seam between them, so clicking a day cell's
// empty background now does nothing; only clicking a specific workout/
// mobility/tournament badge opens its own modal, titled with that item's
// own name instead of the date.
// ==========================================================================
function openWorkoutDetailModal(dateStr, dayId) {
  const entries = calendarEntriesByDate[dateStr] || []
  const entry = entries.find(e => String(e.day.id) === String(dayId))
  if (!entry) return

  const session = sessionByDayId[entry.day.id]
  const showReview = !!session

  // Nothing logged yet to review - go straight to the real Workout Builder
  // (training-builder.html, embedded - see openWorkoutBuilderOverlay) for
  // editing, instead of this popup's own separate, more limited inline
  // editor. Only a day the athlete has already started/finished still opens
  // this popup, to show what they actually logged.
  if (!showReview) {
    openWorkoutBuilderOverlay(dayId, dateStr)
    return
  }

  currentDayDateForModal = dateStr
  root.querySelector('#dayDetailTitle').textContent = trainingDisplayName(entry)

  const exercises = entry.day.program_exercises

  root.querySelector('#dayDetailContent').innerHTML = `
    <div class="detail-group" data-review="true" data-program-day-id="${entry.day.id}">
      <div style="display:flex; justify-content:flex-end; align-items:center; gap:8px; margin-bottom:8px">
        ${entry.day.date_override ? '<span class="athlete-modified-badge">Moved by athlete</span>' : ''}
        <select class="workout-type-select" data-action="set-workout-type" data-day-id="${entry.day.id}">
          ${Object.entries(WORKOUT_TYPE_LABELS_CAL).map(([value, text]) => `<option value="${value}" ${(entry.day.workout_type || 'gym') === value ? 'selected' : ''}>${text}</option>`).join('')}
        </select>
      </div>
      ${renderSessionSummaryCal(session)}
      ${exercises.length === 0
        ? '<p class="no-metrics">No exercises</p>'
        : exercises.map(pe => renderLoggedExerciseCardCal(pe)).join('')}
      <button type="button" class="unit-btn" data-action="toggle-review-edit" style="margin-top:8px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg> Edit Plan Instead</button>
    </div>
  `

  root.querySelector('#dayDetailModal').classList.add('active')
}

// Same training-builder.html iframe overlay the calendar's "+ New Training"
// flow already uses (see #trainingBuilderOverlayModal/#trainingBuilderFrame
// in the TEMPLATE) - ?dayId= instead of ?id= puts training-builder.js into
// "edit this scheduled day's program_exercises" mode rather than "edit a
// Workout Library template's training_exercises" mode (see the isDayMode
// branch throughout training-builder.js). Reused for both a still-empty day
// and one that already has exercises, so a coach gets the exact same
// search-the-library-and-drag / drag-to-reorder experience as building a
// Workout Library entry, whether they're starting from scratch or adjusting
// what's already scheduled. The iframe src itself is a direct assignment,
// not a go() route call - it's pointing an <iframe> at the unchanged
// repo-root training-builder.html, not navigating this app anywhere.
function openWorkoutBuilderOverlay(dayId, dateStr) {
  currentDayDateForModal = dateStr
  trainingBuilderOverlayMode = 'edit-day'
  root.querySelector('#dayDetailModal').classList.remove('active')
  root.querySelector('#trainingBuilderFrame').src = `../training-builder.html?dayId=${dayId}&embed=1`
  root.querySelector('#trainingBuilderOverlayModal').classList.add('active')
}

// Mobility never creates a programs/program_days row, so it's read straight
// from mobilityEntriesByDateCal instead of calendarEntriesByDate
function openMobilityDetailModal(dateStr) {
  const mobility = mobilityEntriesByDateCal[dateStr]
  if (!mobility) return

  currentDayDateForModal = dateStr
  root.querySelector('#dayDetailTitle').innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><circle cx="12" cy="4" r="2"></circle><path d="M12 6v6"></path><path d="M8 8l4 2 4-2"></path><path d="M9 20l3-6 3 6"></path></svg> Mobility / Stretching'

  const mobilityFocusText = mobility.mobility_focus_areas && mobility.mobility_focus_areas.length
    ? mobility.mobility_focus_areas.map(escapeHtmlCal).join(', ')
    : 'Full Body / No preference'

  root.querySelector('#dayDetailContent').innerHTML = `
    <p class="workout-preview-target">${Math.round((new Date(mobility.ended_at) - new Date(mobility.started_at)) / 60000)} min · Focus: ${mobilityFocusText}</p>
  `

  root.querySelector('#dayDetailModal').classList.add('active')
}

// A tournament is its own row, not tied to any scheduled workout
function openTournamentDetailModal(dateStr) {
  const tournament = tournamentsByDateCal[dateStr]
  if (!tournament) return

  currentDayDateForModal = dateStr
  root.querySelector('#dayDetailTitle').innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline></svg> ${escapeHtmlCal(tournament.name)}`

  const tournamentDateRange = tournament.date !== tournament.end_date
    ? `${formatShortDateCal(tournament.date)} – ${formatShortDateCal(tournament.end_date)}`
    : null

  root.querySelector('#dayDetailContent').innerHTML = `
    ${tournamentDateRange ? `<p class="workout-preview-target">${tournamentDateRange}</p>` : ''}
    <p class="workout-preview-target">Importance ${tournament.importance}/5 — ${TOURNAMENT_IMPORTANCE_DESCRIPTIONS_CAL[tournament.importance]}</p>
  `

  root.querySelector('#dayDetailModal').classList.add('active')
}

// Queried fresh (not read from formAssignmentsByDateCal) since the answers
// aren't preloaded for the whole month - only fetched once the coach
// actually opens one specific assignment
async function openFormDetailModal(assignmentId) {
  const token = mountToken
  const { data: assignment, error } = await supabase
    .from('form_assignments')
    .select('*, forms(name, form_questions(*))')
    .eq('id', assignmentId)
    .single()

  if (!nav.isCurrent(token)) return
  if (error) { console.log(error); customAlert('Something went wrong loading that form'); return }

  root.querySelector('#dayDetailTitle').textContent = assignment.forms ? assignment.forms.name : 'Form'

  if (!assignment.completed_at) {
    root.querySelector('#dayDetailContent').innerHTML = '<p class="no-metrics">Not completed yet</p>'
    root.querySelector('#dayDetailModal').classList.add('active')
    return
  }

  const questions = ((assignment.forms && assignment.forms.form_questions) || []).sort((a, b) => a.order_index - b.order_index)

  const { data: answers, error: answersError } = await supabase.from('form_answers').select('*').eq('assignment_id', assignmentId)
  if (!nav.isCurrent(token)) return
  if (answersError) console.log(answersError)
  const answersByQuestion = {}
  for (const a of (answers || [])) answersByQuestion[a.question_id] = a

  root.querySelector('#dayDetailContent').innerHTML = `
    <p class="workout-preview-target">Completed ${new Date(assignment.completed_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
    ${questions.map(q => {
      const a = answersByQuestion[q.id]
      const answerText = a ? (q.type === 'scale_1_5' ? (a.answer_scale != null ? `${a.answer_scale}/5` : '—') : (a.answer_text || '—')) : '—'
      return `
        <div class="form-question-card">
          <p style="color:#aaaacc; font-size:12px; margin-bottom:4px">${escapeHtmlCal(q.question_text)}</p>
          <p style="white-space:pre-wrap">${escapeHtmlCal(answerText)}</p>
        </div>
      `
    }).join('')}
  `

  root.querySelector('#dayDetailModal').classList.add('active')
}

// One header per run of consecutive exercises sharing the same non-null
// section_label - list must already be sorted by order_index. Manually/
// individually added exercises (section_label null) never get a header.
function renderExerciseListHtmlCal(list) {
  let html = ''
  let lastLabel // undefined sentinel - a run of nulls never gets a header
  for (const pe of list) {
    if (pe.section_label !== lastLabel) {
      if (pe.section_label) html += `<div class="builder-section-header">${pe.section_label}</div>`
      lastLabel = pe.section_label
    }
    html += renderScheduledExerciseCard(pe, list)
  }
  return html
}

// Same card look/behaviour as training-builder.js / program-builder.js -
// video thumbnail, one row per set with its own reps/weight target, rest
// time, notes - editing an already-scheduled exercise directly from the
// calendar, same underlying program_exercises table program-builder.js
// edits, just reached a different way (day already has this exercise on it
// vs. picking one to add).
function renderScheduledExerciseCard(pe, siblingExercises) {
  const tracksReps = !pe.exercises || pe.exercises.tracks_reps !== false
  const isTimed = pe.exercises && pe.exercises.is_timed
  const tracksWeight = !pe.exercises || pe.exercises.tracks_weight
  const isUnilateral = pe.exercises && pe.exercises.is_unilateral
  const tracksDistance = pe.exercises && pe.exercises.tracks_distance
  const videoUrl = (pe.exercises && pe.exercises.video_url) || ''
  const thumb = getYouTubeThumbnailCal(videoUrl)
  const targets = deriveSetTargetsCal(pe)
  const rowsHtml = targets.map((t, i) => renderSetTargetRowCal(i + 1, t, tracksReps, isTimed, tracksWeight, isUnilateral, tracksDistance, targets.length === 1)).join('')
  const groupMembers = pe.superset_group_id ? (siblingExercises || []).filter(other => other.id !== pe.id && other.superset_group_id === pe.superset_group_id) : []
  const groupColor = pe.superset_group_id ? colorForSupersetGroupCal(pe.superset_group_id) : null
  const linkTitle = groupMembers.length
    ? `Linked with ${groupMembers.map(m => m.exercises ? m.exercises.name : 'exercise').join(', ')} - tap to remove`
    : 'Link with other exercises (superset)'

  return `
    <div class="builder-exercise-card" data-id="${pe.id}" data-superset-group-id="${pe.superset_group_id || ''}" data-section-instance-id="${pe.section_instance_id || ''}" data-section-label="${pe.section_label || ''}">
      <div class="builder-exercise-card-header">
        <span class="builder-drag-handle" draggable="true" title="Drag to reorder">⠿</span>
        <button type="button" class="builder-exercise-thumb" ${videoUrl ? `data-video-url="${videoUrl}"` : 'disabled'}>
          ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="builder-exercise-thumb-placeholder"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg></span>'}
        </button>
        <div class="builder-exercise-name">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</div>
        ${isUnilateral ? '<span class="builder-unilateral-badge">Each Side</span>' : ''}
        <button type="button" class="builder-link-btn ${pe.superset_group_id ? 'linked' : ''}" data-action="toggle-link" style="${groupColor ? `border-color:${groupColor}; color:${groupColor}; background-color:${groupColor}22` : ''}" title="${linkTitle}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3"></path><line x1="8" y1="12" x2="16" y2="12"></line></svg></button>
        <button type="button" class="btn-delete-measurement" data-action="delete-scheduled" title="Remove exercise"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
      </div>
      <div class="set-target-rows">
        ${rowsHtml}
      </div>
      <button type="button" class="builder-add-set-btn" data-action="add-set">+ Add Set</button>
      <div class="builder-exercise-notes">
        <label>Extra Fields (optional)</label>
        <div class="extra-fields-container" id="extraFieldsSched-${pe.id}"></div>
        <button type="button" class="btn-create-metric" data-action="add-extra-field" style="margin-top:6px">+ Add Field</button>
      </div>
      <div class="builder-exercise-notes">
        <label>Notes (visible to the athlete)</label>
        <textarea class="exercise-notes-input" placeholder="e.g. Focus on controlled tempo">${pe.notes || ''}</textarea>
      </div>
    </div>
  `
}

// Shown at the top of a done/in-progress day's review - just duration + RPE,
// same numbers the athlete's own post-workout summary shows (see
// renderWorkoutSummary in the athlete app's dashboard.js), formatted for a
// one-line glance
function renderSessionSummaryCal(session) {
  if (!session.ended_at) {
    const startedTime = new Date(session.started_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    return `<p class="workout-preview-target" style="margin-bottom:12px"><span class="status-dot-progress"></span> In progress — started ${startedTime}</p>`
  }
  const durationMin = Math.round((new Date(session.ended_at) - new Date(session.started_at)) / 60000)
  const parts = [`⏱ ${durationMin} min`]
  if (session.session_rpe != null) parts.push(`RPE ${session.session_rpe}/10`)

  // Read-only here - "Mark Reviewed" lives on the Overview tab's report
  // inbox, so that stays a single source of truth for that write and
  // Calendar is purely context when browsing history
  const flagHtml = session.rpe_flag_reason === 'pain_injury'
    ? `<p class="pain-flag-note ${session.rpe_flag_reviewed_at ? 'reviewed' : ''}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg> Reported pain/injury${session.rpe_flag_reviewed_at ? ' (reviewed)' : ''}: ${escapeHtmlCal(session.rpe_flag_note) || '<em>No description given</em>'}</p>`
    : ''

  return `<p class="workout-preview-target" style="margin-bottom:${flagHtml ? '4px' : '12px'}">${parts.join(' · ')}</p>${flagHtml}`
}

// Only used for user-entered free text rendered into a coach-facing
// template via innerHTML (the pain/injury note above) - every other
// string here is coach-authored or comes from a fixed set of options, so
// this is deliberately not applied everywhere
function escapeHtmlCal(str) {
  if (!str) return ''
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

// Read-only version of renderScheduledExerciseCard - what the athlete
// actually logged (actual_reps/actual_weight) instead of the coach's
// editable set_targets, so a coach opening a done workout sees a real
// review instead of the still-blank plan they set beforehand
function renderLoggedExerciseCardCal(pe) {
  const isUnilateral = pe.exercises && pe.exercises.is_unilateral
  const videoUrl = (pe.exercises && pe.exercises.video_url) || ''
  const thumb = getYouTubeThumbnailCal(videoUrl)
  const sets = (logSetsByPECal[pe.id] || []).filter(s => s.completed_at).sort((a, b) => a.set_number - b.set_number)

  const rowsHtml = sets.length === 0
    ? '<p class="no-metrics">Not logged yet</p>'
    : `<p class="summary-exercise-sets">${sets.length} set${sets.length === 1 ? '' : 's'}</p>`

  return `
    <div class="builder-exercise-card">
      <div class="builder-exercise-card-header">
        <button type="button" class="builder-exercise-thumb" ${videoUrl ? `data-video-url="${videoUrl}"` : 'disabled'}>
          ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<span class="builder-exercise-thumb-placeholder"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg></span>'}
        </button>
        <div class="builder-exercise-name">${pe.exercises ? pe.exercises.name : 'Unknown exercise'}</div>
        ${isUnilateral ? '<span class="builder-unilateral-badge">Each Side</span>' : ''}
        ${pe.added_by_athlete ? '<span class="athlete-modified-badge">Added by athlete</span>' : ''}
        ${pe.swapped_by_athlete ? '<span class="athlete-modified-badge">Swapped by athlete</span>' : ''}
      </div>
      ${rowsHtml}
    </div>
  `
}

function findScheduledPE(peId) {
  for (const dateStr in calendarEntriesByDate) {
    for (const entry of calendarEntriesByDate[dateStr]) {
      const pe = entry.day.program_exercises.find(p => p.id === peId)
      if (pe) return pe
    }
  }
  return null
}

// Ad-hoc trainings only ever cover the one day they were created for, so
// deleting the whole `programs` row is exactly "delete this training"
// (cascades its week/day/exercises). An assigned template instance can span
// many weeks, so only that one program_days row is removed - the rest of
// the assigned program stays on the calendar untouched.
async function deleteTraining(mode, programId, programDayId) {
  if (!(await customConfirm(mode === 'adhoc'
    ? 'Delete this workout?'
    : 'Remove this day from the assigned program? (The rest of the program stays intact.)'))) return

  const token = mountToken
  const { error } = mode === 'adhoc'
    ? await supabase.from('programs').delete().eq('id', programId)
    : await supabase.from('program_days').delete().eq('id', programDayId)

  if (!nav.isCurrent(token)) return
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  root.querySelector('#dayDetailModal').classList.remove('active')
  await loadCalendarMonth(currentViewYear, currentViewMonth)
}

// A logged mobility session has no program/day/exercises of its own to
// speak of - just delete the workout_sessions row directly. No "copy"
// equivalent makes sense here (there's nothing to schedule ahead of time).
async function deleteMobilitySession(sessionId) {
  if (!(await customConfirm('Delete this mobility session?'))) return

  const token = mountToken
  const { error } = await supabase.from('workout_sessions').delete().eq('id', sessionId)
  if (!nav.isCurrent(token)) return
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  root.querySelector('#dayDetailModal').classList.remove('active')
  await loadCalendarMonth(currentViewYear, currentViewMonth)
}

// Deleting the assignment cascades to its form_answers (if any were
// already submitted) - the form template itself is untouched, so it's
// still there to assign again another day
async function deleteFormAssignment(assignmentId) {
  if (!(await customConfirm('Delete this form assignment? Any answers already submitted will be lost too.'))) return

  const token = mountToken
  const { error } = await supabase.from('form_assignments').delete().eq('id', assignmentId)
  if (!nav.isCurrent(token)) return
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  root.querySelector('#dayDetailModal').classList.remove('active')
  await loadCalendarMonth(currentViewYear, currentViewMonth)
}

// ==========================================================================
// ---- EDIT / DELETE A SCHEDULED EXERCISE ----
// Always-editable card (see renderScheduledExerciseCard above), same
// pattern as training-builder.js/program-builder.js - no modal, and one
// Save button for the whole day's exercises (see saveScheduledDay below)
// instead of one per exercise, since a coach edits a whole day in one
// sitting and only wants to press Save once when it's done.
// ==========================================================================
async function saveScheduledExercise(peId, orderIndex) {
  const card = root.querySelector(`.builder-exercise-card[data-id="${peId}"]`)
  if (!card) return true

  const pe = findScheduledPE(peId)
  const isTimed = !!(pe && pe.exercises && pe.exercises.is_timed)

  const rows = [...card.querySelectorAll('.set-target-row')]
  const setTargets = rows.map(row => {
    const repsInput = row.querySelector('.set-reps-input')
    const reps = repsInput ? (repsInput.value.trim() || null) : null
    let duration = null
    if (isTimed) {
      const mm = parseInt(row.querySelector('.set-time-mm').value) || 0
      const ss = parseInt(row.querySelector('.set-time-ss').value) || 0
      duration = (mm === 0 && ss === 0) ? null : `${mm}:${String(ss).padStart(2, '0')}`
    }
    const weightInput = row.querySelector('.set-weight-input')
    const weight = weightInput && weightInput.value ? parseFloat(weightInput.value) : null
    const distanceInput = row.querySelector('.set-distance-input')
    const distance = distanceInput && distanceInput.value ? parseFloat(distanceInput.value) : null
    const restMm = parseInt(row.querySelector('.set-rest-mm').value) || 0
    const restSs = parseInt(row.querySelector('.set-rest-ss').value) || 0
    const rest = (restMm === 0 && restSs === 0) ? null : restMm * 60 + restSs
    const type = row.querySelector('.set-type-select').value
    return { reps, duration, weight, distance, rest, type }
  })

  const notes = card.querySelector('.exercise-notes-input').value.trim() || null
  const extraFields = collectExtraFieldsCal(`extraFieldsSched-${peId}`)
  const first = setTargets[0] || { reps: null, duration: null, weight: null, rest: null }

  const updates = {
    set_targets: setTargets,
    prescribed_sets: setTargets.length,
    prescribed_reps: first.reps != null ? first.reps : first.duration,
    prescribed_weight: first.weight,
    rest_seconds: first.rest,
    extra_fields: extraFields,
    notes,
    order_index: orderIndex,
    superset_group_id: card.dataset.supersetGroupId || null
  }

  const { error } = await supabase.from('program_exercises').update(updates).eq('id', peId)

  if (error) { console.log(error); return false }
  // Keeps calendarEntriesByDate in sync with what's actually saved - see
  // scheduleAutosaveCal/flushCardSaveCal below.
  if (pe) Object.assign(pe, updates)
  return true
}

// ==========================================================================
// ---- AUTOSAVE ----
// Every set/notes/extra-field edit and superset link/unlink used to only
// persist when the coach pressed a day's "Save" button - matching the same
// "it just stays, unless you change it yourself" reliability the athlete's
// own logging screen already has, every edit here now gets written to the
// database on its own, a moment after the coach stops typing. "Save" still
// exists (it's what closes the modal), but nothing is ever actually
// waiting on it to persist anymore.
// ==========================================================================
function scheduleAutosaveCal(peId) {
  clearTimeout(autosaveTimersCal[peId])
  autosaveTimersCal[peId] = setTimeout(() => flushCardSaveCal(peId), 800)
}

async function flushCardSaveCal(peId) {
  clearTimeout(autosaveTimersCal[peId])
  delete autosaveTimersCal[peId]
  const card = root.querySelector(`.builder-exercise-card[data-id="${peId}"]`)
  if (!card) return true
  const group = card.closest('.detail-group')
  const ids = [...group.querySelectorAll('.builder-exercise-card')].map(c => c.dataset.id)
  const orderIndex = ids.indexOf(peId)
  if (orderIndex === -1) return true
  return saveScheduledExercise(peId, orderIndex)
}

// ==========================================================================
// ---- SUPERSETS (link up to 4 exercises into one giant-set group) ----
// Same pattern as training-builder.js/program-builder.js, scoped to one
// day's .detail-group - every member of a group always has to be within
// the same day. Draft-until-Save, exactly like set_targets/notes.
// ==========================================================================
const SUPERSET_CAP_CAL = 4

function handleLinkClickCal(id, listScopeEl) {
  const card = listScopeEl.querySelector(`.builder-exercise-card[data-id="${id}"]`)
  const currentGroupId = card.dataset.supersetGroupId || null
  if (currentGroupId && !pickingGroupIdsCal) { removeFromSupersetGroupCal(id, listScopeEl); return }
  if (pickingGroupIdsCal && pickingGroupIdsCal[0] === id) { finalizePickingCal(listScopeEl); return }
  if (pickingGroupIdsCal && pickingGroupIdsCal.includes(id)) return // already picked, not the original - ignore
  if (pickingGroupIdsCal) { addToPickingGroupCal(id, listScopeEl); return }
  enterPickingModeCal(id, listScopeEl)
}

function enterPickingModeCal(id, listScopeEl) {
  pickingGroupIdsCal = [id]
  refreshPickingHighlightCal(listScopeEl)
  updatePickingModeBarCal(listScopeEl)
}

// Tapping another unlinked card adds it to the group being built - once
// the cap is hit the group finalizes on its own, no extra tap needed
function addToPickingGroupCal(id, listScopeEl) {
  pickingGroupIdsCal.push(id)
  if (pickingGroupIdsCal.length >= SUPERSET_CAP_CAL) { finalizePickingCal(listScopeEl); return }
  refreshPickingHighlightCal(listScopeEl)
  updatePickingModeBarCal(listScopeEl)
}

function refreshPickingHighlightCal(listScopeEl) {
  listScopeEl.querySelectorAll('.builder-exercise-card').forEach(card => {
    const picked = pickingGroupIdsCal.includes(card.dataset.id)
    const isLinked = !!card.dataset.supersetGroupId
    card.classList.toggle('picking-self', picked)
    card.classList.toggle('pickable', !picked && !isLinked)
  })
}

function exitPickingModeCal(listScopeEl) {
  pickingGroupIdsCal = null
  listScopeEl.querySelectorAll('.builder-exercise-card').forEach(c => c.classList.remove('picking-self', 'pickable'))
  updatePickingModeBarCal(listScopeEl)
}

// Floating bar shown only while picking mode is active - the only way to
// confirm a superset used to be tapping the original card's 🔗 button
// again (undiscoverable, no visible affordance), so this gives an explicit
// "Finish Superset" button for stopping at 2 or 3 instead of the 4-cap
function updatePickingModeBarCal(listScopeEl) {
  const bar = root.querySelector('#pickingModeBar')
  if (!bar) return
  if (!pickingGroupIdsCal) { bar.style.display = 'none'; return }
  bar.style.display = 'flex'
  const n = pickingGroupIdsCal.length
  root.querySelector('#pickingModeBarCount').textContent = `${n} exercise${n === 1 ? '' : 's'} selected`
  const finishBtn = root.querySelector('#pickingModeBarFinishBtn')
  finishBtn.disabled = n < 2
  finishBtn.onclick = () => finalizePickingCal(listScopeEl)
  root.querySelector('#pickingModeBarCancelBtn').onclick = () => exitPickingModeCal(listScopeEl)
}

// Tapping the original card again finishes early with fewer than the cap -
// needs at least 2 to actually form a group, otherwise it's just a cancel
function finalizePickingCal(listScopeEl) {
  if (pickingGroupIdsCal.length < 2) { exitPickingModeCal(listScopeEl); return }
  const groupId = crypto.randomUUID()
  const ids = pickingGroupIdsCal
  ids.forEach(id => {
    listScopeEl.querySelector(`.builder-exercise-card[data-id="${id}"]`).dataset.supersetGroupId = groupId
  })
  exitPickingModeCal(listScopeEl)
  ids.forEach(id => refreshSupersetBadgeCal(listScopeEl.querySelector(`.builder-exercise-card[data-id="${id}"]`), listScopeEl))
  ids.forEach(scheduleAutosaveCal)
}

// Removes just this one card from its group (tapped via 🔗, or from the
// day's delete-exercise handler) - if that would leave only one member,
// that last one is cleared too, since a "group of 1" isn't a superset
function removeFromSupersetGroupCal(id, listScopeEl) {
  const card = listScopeEl.querySelector(`.builder-exercise-card[data-id="${id}"]`)
  const groupId = card.dataset.supersetGroupId
  if (!groupId) return
  delete card.dataset.supersetGroupId
  const remaining = [...listScopeEl.querySelectorAll(`.builder-exercise-card[data-superset-group-id="${groupId}"]`)]
  if (remaining.length === 1) delete remaining[0].dataset.supersetGroupId
  refreshSupersetBadgeCal(card, listScopeEl)
  remaining.forEach(c => refreshSupersetBadgeCal(c, listScopeEl))
  scheduleAutosaveCal(id)
  remaining.forEach(c => scheduleAutosaveCal(c.dataset.id))
}

// Deterministic color per superset group id, so several groups on the
// same day are visually distinguishable at a glance without spelling out
// which exercises are linked (that's in the 🔗 button's title tooltip
// instead) - same group id always resolves to the same color
const SUPERSET_COLORS_CAL = ['#4a4a8e', '#e0a030', '#3aa66e', '#c0466e', '#3a8ec0', '#a05fd6', '#c07a2e', '#5fb8b8']
function colorForSupersetGroupCal(groupId) {
  let hash = 0
  for (let i = 0; i < groupId.length; i++) hash = (hash * 31 + groupId.charCodeAt(i)) >>> 0
  return SUPERSET_COLORS_CAL[hash % SUPERSET_COLORS_CAL.length]
}

function refreshSupersetBadgeCal(card, listScopeEl) {
  const linkBtn = card.querySelector('.builder-link-btn')
  const groupId = card.dataset.supersetGroupId
  linkBtn.classList.toggle('linked', !!groupId)

  if (!groupId) {
    linkBtn.style.borderColor = ''
    linkBtn.style.color = ''
    linkBtn.style.backgroundColor = ''
    linkBtn.title = 'Link with other exercises (superset)'
    return
  }

  const color = colorForSupersetGroupCal(groupId)
  linkBtn.style.borderColor = color
  linkBtn.style.color = color
  linkBtn.style.backgroundColor = color + '22'

  const others = [...listScopeEl.querySelectorAll(`.builder-exercise-card[data-superset-group-id="${groupId}"]`)].filter(c => c !== card)
  const names = others.map(c => c.querySelector('.builder-exercise-name').textContent).filter(Boolean)
  linkBtn.title = names.length ? `Linked with ${names.join(', ')} - tap to remove` : 'Remove from superset'
}

// Saves every exercise card in one day-entry group at once, then closes
// the day-detail modal back to the calendar (that's "done" for a coach
// editing a scheduled day).
async function saveScheduledDay(groupEl) {
  const btn = groupEl.querySelector('[data-action="save-scheduled-day"]')
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...' }

  const cardIds = [...groupEl.querySelectorAll('.builder-exercise-card')].map(card => card.dataset.id)
  cardIds.forEach(id => { clearTimeout(autosaveTimersCal[id]); delete autosaveTimersCal[id] })
  const results = await Promise.all(cardIds.map(saveScheduledExercise))

  if (results.some(ok => !ok)) {
    customAlert('Something went wrong saving one or more exercises - please try again')
    if (btn) { btn.disabled = false; btn.textContent = 'Save' }
    return
  }

  root.querySelector('#dayDetailModal').classList.remove('active')
  await loadCalendarMonth(currentViewYear, currentViewMonth)
}

// Removes just this one card instead of reloading the whole month + rebuilding
// the modal, so unsaved edits sitting in this day's other cards aren't wiped out
async function deleteScheduledExercise(peId) {
  if (!(await customConfirm('Remove this exercise?'))) return

  clearTimeout(autosaveTimersCal[peId])
  delete autosaveTimersCal[peId]
  const card = root.querySelector(`.builder-exercise-card[data-id="${peId}"]`)
  if (card && card.dataset.supersetGroupId) removeFromSupersetGroupCal(peId, card.closest('.detail-group'))

  const { error } = await supabase.from('program_exercises').delete().eq('id', peId)
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  const entries = calendarEntriesByDate[currentDayDateForModal] || []
  for (const entry of entries) {
    const idx = entry.day.program_exercises.findIndex(pe => pe.id === peId)
    if (idx === -1) continue

    entry.day.program_exercises.splice(idx, 1)
    const card = root.querySelector(`.builder-exercise-card[data-id="${peId}"]`)
    const group = card ? card.closest('.detail-group') : null
    if (card) card.remove()
    if (group && group.querySelectorAll('.builder-exercise-card').length === 0) {
      const saveBtn = group.querySelector('[data-action="save-scheduled-day"]')
      if (saveBtn) saveBtn.remove()
      group.insertAdjacentHTML('beforeend', '<p class="no-metrics">No exercises</p>')
    }
    break
  }
}

// ==========================================================================
// ---- ADD TRAINING (hover "+" on a calendar day) ----
// findOrCreateAdHocDay reuses the same ad-hoc day container across the
// Single Workout and Section tabs within ONE popup session (so adding a
// Section then a Training in one sitting combines into one day), but always
// creates a fresh one on a new "+" click - see adHocDayIdForThisSession.
// Only way to put exercises on a day is via a saved Training - no more
// "add one loose exercise" flow, that's what the Training Library /
// training-builder.html is for. Two tabs share this one popup: a single
// saved Training onto just this day, or a whole Program starting on this
// day (see switchDayAddTab below).
// ==========================================================================
async function getTrainingsList() {
  if (cachedTrainings) return cachedTrainings
  const { data, error } = await window.fetchWithRetry((signal) => supabase.from('trainings').select('*').order('created_at', { ascending: false }).abortSignal(signal))
  if (error) { console.log(error); customAlert('Something went wrong loading your workouts - check your connection and try again'); return null }
  cachedTrainings = data
  return cachedTrainings
}

async function getProgramTemplates() {
  if (cachedTemplates) return cachedTemplates
  const { data, error } = await window.fetchWithRetry((signal) => supabase.from('programs').select('*').eq('is_template', true).order('name').abortSignal(signal))
  if (error) { console.log(error); customAlert('Something went wrong loading your programs - check your connection and try again'); return null }
  cachedTemplates = data
  return cachedTemplates
}

// Selecting a row in the list previews it here rather than applying it
// straight away - selectedTraining* remembers what's currently previewed so
// the "Select" button (disabled until something's picked) knows what to
// apply. cachedTrainingExercises avoids re-fetching a preview already seen
// once in this session (e.g. clicking back and forth between two rows).
async function openDayAddTrainingModal(dateStr) {
  currentDayDateForAddTraining = dateStr
  root.querySelector('#dayAddTrainingTitle').textContent = 'Add Workout — ' + formatDisplayDateCal(dateStr)
  switchDayAddTab('workout')
  resetTrainingPreview()
  resetSectionPreviewCal()
  resetFormPreviewCal()

  const data = await getTrainingsList()
  const list = root.querySelector('#dayAddTrainingList')

  if (data === null) {
    list.innerHTML = '<p class="no-metrics">Something went wrong loading the Workout Library</p>'
  } else if (data.length === 0) {
    list.innerHTML = '<p class="no-metrics">No workouts saved yet - create one in the Workout Library first</p>'
  } else {
    list.innerHTML = data.map(t => `
      <div class="training-pick-row" data-id="${t.id}" data-name="${t.name}">
        <span>${t.name}</span>
      </div>
    `).join('')

    list.querySelectorAll('.training-pick-row').forEach(row => {
      row.addEventListener('click', function() {
        list.querySelectorAll('.training-pick-row').forEach(r => r.classList.remove('selected'))
        row.classList.add('selected')
        previewTraining(row.dataset.id, row.dataset.name)
      })
    })
  }

  await loadDayAddProgramList()
  await loadDayAddSectionListCal()
  await loadDayAddFormListCal()

  root.querySelector('#dayAddTrainingModal').classList.add('active')
}

function resetTrainingPreview() {
  selectedTrainingId = null
  selectedTrainingName = null
  root.querySelector('#dayAddTrainingPreview').innerHTML = '<p class="no-metrics">Select a workout to preview it</p>'
  root.querySelector('#selectTrainingForDayBtn').disabled = true
}

async function previewTraining(trainingId, trainingName) {
  selectedTrainingId = trainingId
  selectedTrainingName = trainingName
  root.querySelector('#selectTrainingForDayBtn').disabled = false

  const preview = root.querySelector('#dayAddTrainingPreview')
  preview.innerHTML = '<p class="no-metrics">Loading…</p>'

  let exercises = cachedTrainingExercises[trainingId]
  if (!exercises) {
    const { data, error } = await supabase
      .from('training_exercises')
      .select('*, exercises!exercise_id(name, type, video_url, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')
      .eq('training_id', trainingId)
      .order('order_index')
    if (error) { console.log(error); preview.innerHTML = '<p class="no-metrics">Something went wrong loading this preview</p>'; return }
    exercises = data
    exercises.forEach(applyFieldOverridesCal)
    cachedTrainingExercises[trainingId] = exercises
  }

  // A different row may have been clicked while this was still loading -
  // don't overwrite that newer preview with this now-stale one
  if (selectedTrainingId !== trainingId) return

  preview.innerHTML = `
    <div class="workout-preview-header">
      <h3>${trainingName}</h3>
      <span class="workout-preview-count">${exercises.length} Exercise${exercises.length === 1 ? '' : 's'}</span>
    </div>
    ${exercises.length === 0
      ? '<p class="no-metrics">No exercises in this workout</p>'
      : exercises.map(renderWorkoutPreviewExercise).join('')}
  `
}

function renderWorkoutPreviewExercise(te) {
  const thumb = getYouTubeThumbnailCal((te.exercises && te.exercises.video_url) || '')
  const target = targetLineForTraining(te)

  return `
    <div class="workout-preview-exercise">
      <div class="workout-preview-thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg>'}</div>
      <div class="workout-preview-info">
        <div class="workout-preview-name">${te.exercises ? te.exercises.name : 'Unknown exercise'}</div>
        ${target ? `<div class="workout-preview-target">${target}</div>` : ''}
      </div>
    </div>
  `
}

// A timed set's reps field is free text (the coach could type "45", "45s",
// "1 min", etc) - only append "sec" when it's a plain number, so we don't
// double up on a unit that was already typed in
function formatTimedRepsCal(val) {
  if (!val && val !== 0) return '-'
  return /^\d+(\.\d+)?$/.test(String(val).trim()) ? `${val} sec` : val
}

// "12/10/8 reps @ 50kg" when only reps vary across sets, "12@40kg, 10@45kg,
// 8@50kg" for a real pyramid. Returns null when this exercise has no
// per-set targets yet, so callers fall back to the old single-value summary.
// A distance-tracking exercise gets a " · 400m" (or per-set "400m/300m")
// suffix appended, independent of the reps/weight branch above it.
function formatSetTargetsCal(setTargets, isTimed, tracksWeight, tracksDistance) {
  if (!setTargets || setTargets.length === 0) return null
  let text
  if (isTimed && !tracksWeight) {
    text = setTargets.map(s => formatTimedRepsCal(s.reps)).join(' / ')
  } else if (isTimed && tracksWeight) {
    text = setTargets.map(s => `${formatTimedRepsCal(s.reps)}${s.weight != null ? ' @ ' + s.weight + 'kg' : ''}`).join(', ')
  } else {
    const sameWeight = setTargets.every(s => s.weight === setTargets[0].weight)
    if (sameWeight) {
      const reps = setTargets.map(s => s.reps || '-').join('/')
      text = `${reps} reps${setTargets[0].weight != null ? ' @ ' + setTargets[0].weight + 'kg' : ''}`
    } else {
      text = setTargets.map(s => `${s.reps || '-'}${s.weight != null ? '@' + s.weight + 'kg' : ''}`).join(', ')
    }
  }
  if (tracksDistance && setTargets.some(s => s.distance != null)) {
    const sameDistance = setTargets.every(s => s.distance === setTargets[0].distance)
    text += ' · ' + (sameDistance ? `${setTargets[0].distance}m` : setTargets.map(s => s.distance != null ? `${s.distance}m` : '-').join('/'))
  }
  return text
}

function targetLineForTraining(te) {
  const isTimed = te.exercises && te.exercises.is_timed
  const tracksWeight = !te.exercises || te.exercises.tracks_weight
  const tracksDistance = te.exercises && te.exercises.tracks_distance
  const setTargetsText = formatSetTargetsCal(te.set_targets, isTimed, tracksWeight, tracksDistance)
  const parts = []
  if (setTargetsText) {
    parts.push(setTargetsText)
  } else {
    if (te.prescribed_sets) parts.push(`${te.prescribed_sets} sets`)
    if (te.prescribed_reps) parts.push(isTimed ? formatTimedRepsCal(te.prescribed_reps) : `${te.prescribed_reps} reps`)
    if (te.prescribed_weight && tracksWeight) parts.push(`${te.prescribed_weight}kg`)
  }
  if (te.extra_fields) {
    for (const [k, v] of Object.entries(te.extra_fields)) parts.push(`${k}: ${v}`)
  }
  return parts.join(' × ')
}

function getYouTubeThumbnailCal(url) {
  if (!url) return null
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  return match ? `https://img.youtube.com/vi/${match[1]}/mqdefault.jpg` : null
}

function switchDayAddTab(tab) {
  root.querySelector('#dayAddTabWorkout').classList.toggle('active', tab === 'workout')
  root.querySelector('#dayAddTabProgram').classList.toggle('active', tab === 'program')
  root.querySelector('#dayAddTabSection').classList.toggle('active', tab === 'section')
  root.querySelector('#dayAddTabForm').classList.toggle('active', tab === 'form')
  root.querySelector('#dayAddWorkoutPanel').classList.toggle('active', tab === 'workout')
  root.querySelector('#dayAddProgramPanel').classList.toggle('active', tab === 'program')
  root.querySelector('#dayAddSectionPanel').classList.toggle('active', tab === 'section')
  root.querySelector('#dayAddFormPanel').classList.toggle('active', tab === 'form')
}

// ==========================================================================
// ---- PROGRAM TAB: list + preview + day-range picker ----
// Same list-then-preview pattern as the Single Workout tab, but the
// preview is a flat "Day N - label (x exercises)" list instead of full
// exercise detail (a program can be 100+ days long). No start-date field -
// the calendar day that was clicked to open this popup always becomes
// whatever day the range picker below calls "day 1". selectedProgramDays
// stores the parsed day list so the range picker knows the program's
// total length without a second fetch.
// ==========================================================================
async function loadDayAddProgramList() {
  const data = await getProgramTemplates()
  const list = root.querySelector('#dayAddProgramList')
  resetProgramPreview()

  if (data === null) {
    list.innerHTML = '<p class="no-metrics">Something went wrong loading your programs</p>'
  } else if (data.length === 0) {
    list.innerHTML = '<p class="no-metrics">No program templates saved yet - create one in the Program Library first</p>'
  } else {
    list.innerHTML = data.map(t => `
      <div class="training-pick-row" data-id="${t.id}" data-name="${t.name}">
        <span>${t.name}</span>
      </div>
    `).join('')

    list.querySelectorAll('.training-pick-row').forEach(row => {
      row.addEventListener('click', function() {
        list.querySelectorAll('.training-pick-row').forEach(r => r.classList.remove('selected'))
        row.classList.add('selected')
        previewTemplate(row.dataset.id, row.dataset.name)
      })
    })
  }
}

function resetProgramPreview() {
  selectedTemplateId = null
  selectedTemplateName = null
  root.querySelector('#dayAddProgramPreview').innerHTML = '<p class="no-metrics">Select a program to preview it</p>'
  root.querySelector('#dayRangeRow').style.display = 'none'
  root.querySelector('#saveDayAddProgramBtn').disabled = true
}

async function previewTemplate(templateId, templateName) {
  const token = mountToken
  selectedTemplateId = templateId
  selectedTemplateName = templateName

  const preview = root.querySelector('#dayAddProgramPreview')
  preview.innerHTML = '<p class="no-metrics">Loading…</p>'

  let details = cachedTemplateDays[templateId]
  if (!details) {
    const { data, error } = await supabase
      .from('program_weeks')
      .select('*, program_days(*, program_exercises(id))')
      .eq('program_id', templateId)
    if (!nav.isCurrent(token)) return
    if (error) { console.log(error); preview.innerHTML = '<p class="no-metrics">Something went wrong loading this preview</p>'; return }
    details = buildTemplateDayList(data)
    cachedTemplateDays[templateId] = details
  }

  // A different row may have been clicked while this was still loading -
  // don't overwrite that newer preview/range with this now-stale one
  if (selectedTemplateId !== templateId) return

  totalProgramDays = Math.max(details.totalWeeks * 7, 1)
  programStartDay = 1
  programEndDay = totalProgramDays
  updateDayRangeLabels()
  root.querySelector('#dayRangeRow').style.display = 'flex'
  root.querySelector('#saveDayAddProgramBtn').disabled = false

  preview.innerHTML = `
    <div class="workout-preview-header">
      <h3>${templateName}</h3>
      <span class="workout-preview-count">${details.totalWeeks} week${details.totalWeeks === 1 ? '' : 's'}</span>
    </div>
    ${details.days.length === 0
      ? '<p class="no-metrics">No days scheduled in this program</p>'
      : details.days.map(d => `
        <div class="program-preview-day-row">
          <span class="program-preview-day-num">Day ${d.linearDay}</span>
          <span class="program-preview-day-label">${d.label || 'Day ' + d.dayNumber}${d.exerciseCount ? ' · ' + d.exerciseCount + ' exercises' : ''}</span>
        </div>
      `).join('')}
  `
}

// linearDay is the day's position counting straight through the whole
// program (week 3, day 2 -> (3-1)*7+2 = 16th day) - the same "Day N"
// numbering resolveDate() already uses everywhere else in this app
function buildTemplateDayList(weeks) {
  const days = []
  let totalWeeks = 0
  for (const week of weeks) {
    totalWeeks = Math.max(totalWeeks, week.week_number)
    for (const day of week.program_days) {
      days.push({
        linearDay: (week.week_number - 1) * 7 + day.day_number,
        dayNumber: day.day_number,
        label: day.label,
        exerciseCount: day.program_exercises.length
      })
    }
  }
  days.sort((a, b) => a.linearDay - b.linearDay)
  return { days, totalWeeks }
}

function updateDayRangeLabels() {
  root.querySelector('#programStartDayLabel').textContent = 'Day ' + programStartDay
  root.querySelector('#programEndDayLabel').textContent = 'Day ' + programEndDay
}

function setProgramStartDay(day) {
  programStartDay = day
  if (programStartDay > programEndDay) programEndDay = programStartDay
  updateDayRangeLabels()
}

function setProgramEndDay(day) {
  programEndDay = day
  if (programEndDay < programStartDay) programStartDay = programEndDay
  updateDayRangeLabels()
}

// ---- Day Picker modal: a paginated grid of day numbers (4 weeks/28 days
// per page), reused for both the Start and End fields via dayPickerTarget ----
function openDayPicker(target) {
  dayPickerTarget = target
  const current = target === 'start' ? programStartDay : programEndDay
  dayPickerPage = Math.floor((current - 1) / 28)
  renderDayPickerGrid()
  root.querySelector('#dayPickerModal').classList.add('active')
}

function renderDayPickerGrid() {
  const totalWeeks = Math.max(Math.ceil(totalProgramDays / 7), 1)
  const pageCount = Math.max(Math.ceil(totalWeeks / 4), 1)
  dayPickerPage = Math.max(0, Math.min(dayPickerPage, pageCount - 1))

  const firstWeek = dayPickerPage * 4 + 1
  const lastWeek = Math.min(firstWeek + 3, totalWeeks)
  root.querySelector('#dayPickerRangeLabel').textContent = `Week ${firstWeek} - ${lastWeek} of ${totalWeeks}`

  const firstDay = (firstWeek - 1) * 7 + 1
  const lastDay = Math.min(lastWeek * 7, totalProgramDays)
  const current = dayPickerTarget === 'start' ? programStartDay : programEndDay

  let cellsHtml = ''
  for (let d = firstDay; d <= lastDay; d++) {
    cellsHtml += `<button type="button" class="day-picker-cell ${d === current ? 'selected' : ''}" data-day="${d}">${String(d).padStart(2, '0')}</button>`
  }
  const grid = root.querySelector('#dayPickerGrid')
  grid.innerHTML = cellsHtml

  grid.querySelectorAll('.day-picker-cell').forEach(cell => {
    cell.addEventListener('click', function() {
      const day = parseInt(cell.dataset.day)
      if (dayPickerTarget === 'start') setProgramStartDay(day)
      else setProgramEndDay(day)
      root.querySelector('#dayPickerModal').classList.remove('active')
    })
  })

  root.querySelector('#dayPickerPrevBtn').disabled = dayPickerPage === 0
  root.querySelector('#dayPickerNextBtn').disabled = dayPickerPage >= pageCount - 1
}

// Just closes back to the calendar month view afterward - already saw a
// preview of this training before hitting Select, so popping the day
// detail modal open again on top of that would just be showing it a
// second time. Clicking the day itself still opens it if wanted.
async function applyTrainingToDay(trainingId, trainingName, dateStr) {
  const dayId = await findOrCreateAdHocDay(dateStr, trainingName)
  await cloneTrainingToDay(trainingId, dayId)

  // Only stamps the type if this day doesn't already have one - same
  // "don't clobber what's already set" reasoning as the day's label. A
  // separate query since findOrCreateAdHocDay (shared with the Section tab,
  // which reuses the same day within one "+ Add Workout" popup session)
  // only ever returns an id, not the day's current fields
  const training = (cachedTrainings || []).find(t => t.id === trainingId)
  if (training && training.workout_type) {
    const { data: dayRow } = await supabase.from('program_days').select('workout_type').eq('id', dayId).single()
    if (dayRow && !dayRow.workout_type) {
      await supabase.from('program_days').update({ workout_type: training.workout_type }).eq('id', dayId)
    }
  }

  root.querySelector('#dayAddTrainingModal').classList.remove('active')
  await loadCalendarMonth(currentViewYear, currentViewMonth)
}

// Copies a saved training's exercise list onto an ad-hoc day - a real copy,
// same reasoning as cloneTemplateToAthlete() below: editing the Training
// Library entry later shouldn't retroactively change a day already built
// from it.
//
// Offsets order_index past whatever's already on the target day (same fix
// as cloneSectionToDayCal below) instead of copying verbatim - copying
// verbatim used to collide/interleave order_index with any exercises
// already on that day (e.g. adding a second Training to a day that already
// has one), which is what made a second workout look like it silently
// failed to add.
async function cloneTrainingToDay(trainingId, dayId) {
  const { data: trainingExercises, error } = await supabase
    .from('training_exercises')
    .select('*')
    .eq('training_id', trainingId)

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  trainingExercises.sort((a, b) => a.order_index - b.order_index)

  if (trainingExercises.length === 0) return

  const { data: existingExercises, error: existingError } = await supabase
    .from('program_exercises')
    .select('order_index')
    .eq('day_id', dayId)
  if (existingError) { console.log(existingError); customAlert('Something went wrong'); return }
  const baseOrder = existingExercises.length ? Math.max(...existingExercises.map(pe => pe.order_index)) + 1 : 0

  // A Training built with a Section or superset inside it carries
  // section_label/section_instance_id/superset_group_id on its own
  // training_exercises rows (see insertSectionIntoTraining) - this clone
  // path was written before any of that existed and never copied them
  // over, so assigning such a Training to a calendar day silently dropped
  // every section/superset link. Fresh id per distinct value found in this
  // batch, same reasoning as cloneSectionToDayCal just below - so
  // assigning the same Training to more than one day never makes two
  // different days' exercises look linked to each other.
  const groupIdMap = {}
  const sectionInstanceMap = {}
  for (const te of trainingExercises) {
    if (te.superset_group_id && !groupIdMap[te.superset_group_id]) groupIdMap[te.superset_group_id] = crypto.randomUUID()
    if (te.section_instance_id && !sectionInstanceMap[te.section_instance_id]) sectionInstanceMap[te.section_instance_id] = crypto.randomUUID()
  }

  // One bulk insert instead of one insert per exercise - used to be N
  // sequential round-trips for an N-exercise training
  const { error: insertError } = await supabase.from('program_exercises').insert(
    trainingExercises.map((te, i) => ({
      day_id: dayId,
      exercise_id: te.exercise_id,
      order_index: baseOrder + i,
      prescribed_sets: te.prescribed_sets,
      prescribed_reps: te.prescribed_reps,
      prescribed_weight: te.prescribed_weight,
      rest_seconds: te.rest_seconds,
      extra_fields: te.extra_fields,
      set_targets: te.set_targets,
      notes: te.notes,
      section_label: te.section_label,
      section_instance_id: te.section_instance_id ? sectionInstanceMap[te.section_instance_id] : null,
      superset_group_id: te.superset_group_id ? groupIdMap[te.superset_group_id] : null,
      // Carry any "Adjust Fields" per-instance overrides from the Training
      // over to this real athlete day - without this, assigning a Training
      // whose exercises were adjusted in Workout Builder would silently
      // lose those adjustments the moment it landed on a calendar day
      tracks_weight_override: te.tracks_weight_override,
      is_timed_override: te.is_timed_override,
      is_unilateral_override: te.is_unilateral_override,
      tracks_distance_override: te.tracks_distance_override,
      alternative_exercise_id: te.alternative_exercise_id
    }))
  )
  if (insertError) { console.log(insertError); customAlert('Something went wrong copying the exercises'); return }
}

// name is only used the first time a training is created for this popup
// session - reusing across tabs (e.g. add a Section, then a Training, both
// in the same "+ Add Workout" popup) is what combines them into one day;
// see adHocDayIdForThisSession above for why this is no longer a
// date-based database lookup
async function findOrCreateAdHocDay(dateStr, name) {
  if (adHocDayIdForThisSession && adHocDayDateForThisSession === dateStr) {
    return adHocDayIdForThisSession
  }

  const { data: newProgram, error: programError } = await supabase
    .from('programs')
    .insert([{ coach_id: coachId(), athlete_id: athleteId, is_template: false, is_adhoc: true, start_date: dateStr, name: name || 'Workout' }])
    .select()
  if (programError) { console.log(programError); customAlert('Something went wrong'); throw programError }

  const { data: newWeek, error: weekError } = await supabase
    .from('program_weeks')
    .insert([{ program_id: newProgram[0].id, week_number: 1 }])
    .select()
  if (weekError) { console.log(weekError); customAlert('Something went wrong'); throw weekError }

  const { data: newDay, error: dayError } = await supabase
    .from('program_days')
    .insert([{ week_id: newWeek[0].id, day_number: 1 }])
    .select()
  if (dayError) { console.log(dayError); customAlert('Something went wrong'); throw dayError }

  adHocDayIdForThisSession = newDay[0].id
  adHocDayDateForThisSession = dateStr
  return newDay[0].id
}

// ==========================================================================
// ---- ARM-AND-DROP COPYING (single workout, from the ⋮ menu, and a full
// week, from the copy icon in the grid's left gutter) ----
// No date-picker popup - clicking either entry point "arms" a copy (shown
// via the floating bar below) and the grid itself becomes the target
// picker: hovering highlights the day (workout mode) or whole week (week
// mode) under the cursor with a "Drop Here"/"Drop Week Here" label, and
// clicking commits it there. Nothing outside the grid is blocked while
// armed - Prev/Next, the sidebar, etc. all still work normally, since only
// clicks that land inside #calendarGrid are intercepted (see
// wireCalendarCopyArming below). Escape disarms too - see onDocKeydownCal
// in mount(), which already calls disarmCopy() below.
// ==========================================================================
function armCopyWeek(mondayStr) {
  copyArmedMode = 'week'
  copyArmedSourceMonday = mondayStr
  copyArmedSourceDayId = null
  copyArmedSourceName = null
  copyArmedHoverKey = null
  showCopyArmedBar(`Copying week of ${formatShortDateCal(mondayStr)} — click a week on the calendar to copy it there (hold Shift to paste onto more than one)`)
}

function armCopyWorkout(dayId, name) {
  copyArmedMode = 'workout'
  copyArmedSourceDayId = dayId
  copyArmedSourceName = name
  copyArmedSourceMonday = null
  copyArmedHoverKey = null
  showCopyArmedBar(`Copying "${name}" — click a day on the calendar to copy it there (hold Shift to paste onto more than one)`)
}

function disarmCopy() {
  copyArmedMode = null
  copyArmedSourceDayId = null
  copyArmedSourceName = null
  copyArmedSourceMonday = null
  copyArmedHoverKey = null
  root.querySelector('#copyArmedBar').classList.remove('active')
  clearCopyHoverHighlight()
}

function showCopyArmedBar(text) {
  root.querySelector('#copyArmedBarText').textContent = text
  root.querySelector('#copyArmedBar').classList.add('active')
}

function clearCopyHoverHighlight() {
  root.querySelectorAll('#calendarGrid .calendar-day.copy-target-hover').forEach(el => el.classList.remove('copy-target-hover'))
  root.querySelector('#copyDropLabel').classList.remove('active')
}

function positionCopyDropLabel(cellEls, text) {
  const wrap = root.querySelector('#calendarGridWrap')
  const wrapRect = wrap.getBoundingClientRect()
  const rects = [...cellEls].map(el => el.getBoundingClientRect())
  const left = Math.min(...rects.map(r => r.left)) - wrapRect.left
  const right = Math.max(...rects.map(r => r.right)) - wrapRect.left
  const top = Math.min(...rects.map(r => r.top)) - wrapRect.top
  const bottom = Math.max(...rects.map(r => r.bottom)) - wrapRect.top
  const label = root.querySelector('#copyDropLabel')
  label.style.left = `${(left + right) / 2}px`
  label.style.top = `${(top + bottom) / 2}px`
  label.textContent = text
  label.classList.add('active')
}

function updateCopyHoverHighlight(cellEl) {
  if (!copyArmedMode || !cellEl) { clearCopyHoverHighlight(); copyArmedHoverKey = null; return }

  if (copyArmedMode === 'week') {
    const weekMonday = cellEl.dataset.weekMonday
    if (weekMonday === copyArmedHoverKey) return
    copyArmedHoverKey = weekMonday
    if (weekMonday === copyArmedSourceMonday) { clearCopyHoverHighlight(); return }
    root.querySelectorAll('#calendarGrid .calendar-day.copy-target-hover').forEach(el => el.classList.remove('copy-target-hover'))
    const rowCells = root.querySelectorAll(`#calendarGrid .calendar-day[data-week-monday="${weekMonday}"]`)
    rowCells.forEach(el => el.classList.add('copy-target-hover'))
    positionCopyDropLabel(rowCells, 'Drop Week Here')
  } else {
    const dateStr = cellEl.dataset.date
    if (dateStr === copyArmedHoverKey) return
    copyArmedHoverKey = dateStr
    root.querySelectorAll('#calendarGrid .calendar-day.copy-target-hover').forEach(el => el.classList.remove('copy-target-hover'))
    cellEl.classList.add('copy-target-hover')
    positionCopyDropLabel([cellEl], 'Drop Here')
  }
}

// Loops the 7 days from sourceMonday to targetMonday, reusing
// cloneDayToDate() below as-is for each scheduled day - it already does the
// full clone (fresh ad-hoc program/week/day, superset/section id remap,
// overrides carried over), so this is just that function called once per
// matched day. Dedupes by day.id the same way renderCalendarGrid's own
// badge list does, so a day with several workouts scheduled gets all of
// them copied, not just the first.
async function performCopyWeek(sourceMonday, targetMonday) {
  const fromStart = parseDateStr(sourceMonday)
  const toStart = parseDateStr(targetMonday)
  for (let i = 0; i < 7; i++) {
    const sourceDate = toDateStr(new Date(fromStart.getFullYear(), fromStart.getMonth(), fromStart.getDate() + i))
    const targetDate = toDateStr(new Date(toStart.getFullYear(), toStart.getMonth(), toStart.getDate() + i))
    const entries = [...new Map((calendarEntriesByDate[sourceDate] || []).map(e => [e.day.id, e])).values()]
    for (const entry of entries) {
      await cloneDayToDate(entry.day.id, trainingDisplayName(entry), targetDate)
    }
  }
  await loadCalendarMonth(currentViewYear, currentViewMonth)
}

// Wired once on the persistent #calendarGrid node, same reasoning as
// wireCalendarDragToMove/wireCalendarBadgeKebabs. Registered BEFORE
// wireCalendarBadgeKebabs (see activateCalendarTab) so its capture-phase
// listener runs first and can stopImmediatePropagation to swallow a click
// before the kebab/day-open listeners ever see it.
function wireCalendarCopyArming(grid) {
  grid.addEventListener('mousemove', function(e) {
    if (!copyArmedMode) return
    updateCopyHoverHighlight(e.target.closest('.calendar-day'))
  })
  grid.addEventListener('mouseleave', function() {
    if (!copyArmedMode) return
    copyArmedHoverKey = null
    clearCopyHoverHighlight()
  })

  grid.addEventListener('click', async function(e) {
    const armBtn = e.target.closest('[data-action="arm-copy-week"]')
    if (armBtn) {
      e.stopImmediatePropagation()
      e.preventDefault()
      if (copyArmedMode === 'week' && copyArmedSourceMonday === armBtn.dataset.weekMonday) disarmCopy()
      else armCopyWeek(armBtn.dataset.weekMonday)
      return
    }

    if (!copyArmedMode) return
    const cell = e.target.closest('.calendar-day')
    if (!cell) return
    e.stopImmediatePropagation()
    e.preventDefault()

    // Holding Shift pastes without disarming, so copying one day onto
    // several others (or one week onto several) is just repeated
    // shift-clicks instead of re-arming from scratch each time.
    // loadCalendarMonth/the week-copy path both redraw the grid from fresh
    // HTML, wiping any .copy-target-hover class along with it - clearing
    // copyArmedHoverKey forces the very next mousemove to re-highlight
    // immediately instead of the old highlight just staying gone until the
    // mouse happens to move.
    const keepArmed = e.shiftKey

    if (copyArmedMode === 'week') {
      const targetMonday = cell.dataset.weekMonday
      const sourceMonday = copyArmedSourceMonday
      if (keepArmed) { copyArmedHoverKey = null } else { disarmCopy() }
      if (targetMonday === sourceMonday) return
      await performCopyWeek(sourceMonday, targetMonday)
    } else {
      const targetDate = cell.dataset.date
      const sourceDayId = copyArmedSourceDayId
      const sourceName = copyArmedSourceName
      if (keepArmed) { copyArmedHoverKey = null } else { disarmCopy() }
      await cloneDayToDate(sourceDayId, sourceName, targetDate)
      await loadCalendarMonth(currentViewYear, currentViewMonth)
    }
  }, true)
}

async function createFreshAdHocDay(dateStr, name, workoutType) {
  const { data: newProgram, error: programError } = await supabase
    .from('programs')
    .insert([{ coach_id: coachId(), athlete_id: athleteId, is_template: false, is_adhoc: true, start_date: dateStr, name: name || 'Workout' }])
    .select()
  if (programError) { console.log(programError); customAlert('Something went wrong'); throw programError }

  const { data: newWeek, error: weekError } = await supabase
    .from('program_weeks')
    .insert([{ program_id: newProgram[0].id, week_number: 1 }])
    .select()
  if (weekError) { console.log(weekError); customAlert('Something went wrong'); throw weekError }

  const { data: newDay, error: dayError } = await supabase
    .from('program_days')
    .insert([{ week_id: newWeek[0].id, day_number: 1, workout_type: workoutType || null }])
    .select()
  if (dayError) { console.log(dayError); customAlert('Something went wrong'); throw dayError }

  return newDay[0].id
}

// program_exercises never stores logged data (that lives in
// exercise_log_sets/workout_sessions, separate tables) - so copying these
// rows straight is already "fresh and unlogged" with no extra filtering
// needed, even when the source day is already completed. Same clone shape
// as cloneTrainingToDay above (order_index offset, superset/section id
// remap, Adjust Fields overrides carried over) - just sourced from an
// existing day's program_exercises instead of a Training Library entry.
async function cloneDayToDate(sourceDayId, name, targetDateStr) {
  const [{ data: sourceDay }, { data: sourceExercises, error }] = await Promise.all([
    supabase.from('program_days').select('workout_type').eq('id', sourceDayId).single(),
    supabase.from('program_exercises').select('*').eq('day_id', sourceDayId)
  ])
  if (error) { console.log(error); customAlert('Something went wrong'); return }

  sourceExercises.sort((a, b) => a.order_index - b.order_index)

  const newDayId = await createFreshAdHocDay(targetDateStr, name, sourceDay && sourceDay.workout_type)
  if (sourceExercises.length === 0) return

  const groupIdMap = {}
  const sectionInstanceMap = {}
  for (const pe of sourceExercises) {
    if (pe.superset_group_id && !groupIdMap[pe.superset_group_id]) groupIdMap[pe.superset_group_id] = crypto.randomUUID()
    if (pe.section_instance_id && !sectionInstanceMap[pe.section_instance_id]) sectionInstanceMap[pe.section_instance_id] = crypto.randomUUID()
  }

  const { error: insertError } = await supabase.from('program_exercises').insert(
    sourceExercises.map((pe, i) => ({
      day_id: newDayId,
      exercise_id: pe.exercise_id,
      order_index: i,
      prescribed_sets: pe.prescribed_sets,
      prescribed_reps: pe.prescribed_reps,
      prescribed_weight: pe.prescribed_weight,
      rest_seconds: pe.rest_seconds,
      extra_fields: pe.extra_fields,
      set_targets: pe.set_targets,
      notes: pe.notes,
      section_label: pe.section_label,
      section_instance_id: pe.section_instance_id ? sectionInstanceMap[pe.section_instance_id] : null,
      superset_group_id: pe.superset_group_id ? groupIdMap[pe.superset_group_id] : null,
      tracks_weight_override: pe.tracks_weight_override,
      is_timed_override: pe.is_timed_override,
      is_unilateral_override: pe.is_unilateral_override,
      tracks_distance_override: pe.tracks_distance_override,
      alternative_exercise_id: pe.alternative_exercise_id
    }))
  )
  if (insertError) { console.log(insertError); customAlert('Something went wrong copying the exercises'); return }
}

// ==========================================================================
// ---- SECTION TAB: list + preview + bulk-insert ----
// Same list-then-preview pattern as the Single Workout tab. Reuses
// renderWorkoutPreviewExercise/targetLineForTraining as-is for the preview
// - a section_exercises row has the exact same shape (exercise_id,
// prescribed_*, set_targets, extra_fields, notes, joined exercises) those
// already render, so no new preview renderer is needed here.
// ==========================================================================
async function getSectionsListCal() {
  if (cachedSectionsCal) return cachedSectionsCal
  const { data, error } = await window.fetchWithRetry((signal) => supabase.from('sections').select('*').order('name').abortSignal(signal))
  if (error) { console.log(error); customAlert('Something went wrong loading your sections - check your connection and try again'); return null }
  cachedSectionsCal = data
  return cachedSectionsCal
}

function resetSectionPreviewCal() {
  selectedSectionIdCal = null
  selectedSectionNameCal = null
  root.querySelector('#dayAddSectionPreview').innerHTML = '<p class="no-metrics">Select a section to preview it</p>'
  root.querySelector('#selectSectionForDayBtn').disabled = true
}

async function loadDayAddSectionListCal() {
  resetSectionPreviewCal()
  const data = await getSectionsListCal()
  const list = root.querySelector('#dayAddSectionList')

  if (data === null) {
    list.innerHTML = '<p class="no-metrics">Something went wrong loading the Section Library</p>'
  } else if (data.length === 0) {
    list.innerHTML = '<p class="no-metrics">No sections saved yet - create one in the Section Library first</p>'
  } else {
    list.innerHTML = data.map(s => `
      <div class="training-pick-row" data-id="${s.id}" data-name="${s.name}">
        <span>${s.name}</span>
      </div>
    `).join('')

    list.querySelectorAll('.training-pick-row').forEach(row => {
      row.addEventListener('click', function() {
        list.querySelectorAll('.training-pick-row').forEach(r => r.classList.remove('selected'))
        row.classList.add('selected')
        previewSectionCal(row.dataset.id, row.dataset.name)
      })
    })
  }
}

async function previewSectionCal(sectionId, sectionName) {
  selectedSectionIdCal = sectionId
  selectedSectionNameCal = sectionName
  root.querySelector('#selectSectionForDayBtn').disabled = false

  const preview = root.querySelector('#dayAddSectionPreview')
  preview.innerHTML = '<p class="no-metrics">Loading…</p>'

  let exercises = cachedSectionExercisesCal[sectionId]
  if (!exercises) {
    const { data, error } = await supabase
      .from('section_exercises')
      .select('*, exercises!exercise_id(name, type, video_url, tracks_reps, tracks_weight, is_timed, is_unilateral, tracks_distance)')
      .eq('section_id', sectionId)
      .order('order_index')
    if (error) { console.log(error); preview.innerHTML = '<p class="no-metrics">Something went wrong loading this preview</p>'; return }
    exercises = data
    cachedSectionExercisesCal[sectionId] = exercises
  }

  if (selectedSectionIdCal !== sectionId) return

  preview.innerHTML = `
    <div class="workout-preview-header">
      <h3>${sectionName}</h3>
      <span class="workout-preview-count">${exercises.length} Exercise${exercises.length === 1 ? '' : 's'}</span>
    </div>
    ${exercises.length === 0
      ? '<p class="no-metrics">No exercises in this section</p>'
      : exercises.map(renderWorkoutPreviewExercise).join('')}
  `
}

async function applySectionToDayCal(sectionId, sectionName, dateStr) {
  const dayId = await findOrCreateAdHocDay(dateStr, sectionName)
  await cloneSectionToDayCal(sectionId, sectionName, dayId)
  root.querySelector('#dayAddTrainingModal').classList.remove('active')
  await loadCalendarMonth(currentViewYear, currentViewMonth)
}

// Fixed version of cloneTrainingToDay's copy - offsets order_index past
// whatever's already on the target day instead of copying verbatim, so
// repeated adds to the same day (or a day that already has a scheduled
// workout) never collide/interleave.
async function cloneSectionToDayCal(sectionId, sectionName, dayId) {
  const { data: sectionExercises, error } = await supabase
    .from('section_exercises')
    .select('*')
    .eq('section_id', sectionId)

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  sectionExercises.sort((a, b) => a.order_index - b.order_index)
  if (sectionExercises.length === 0) return

  const { data: existing, error: existingError } = await supabase
    .from('program_exercises')
    .select('order_index')
    .eq('day_id', dayId)
  if (existingError) { console.log(existingError); customAlert('Something went wrong'); return }
  const baseOrder = existing.length ? Math.max(...existing.map(pe => pe.order_index)) + 1 : 0

  // Fresh group id per distinct superset_group_id in this batch, so
  // inserting the same section twice into one day doesn't make both
  // copies' supersets collide into a single group - same reasoning as the
  // baseOrder offset just above, applied to group ids instead of order_index
  const groupIdMap = {}
  for (const se of sectionExercises) {
    if (se.superset_group_id && !groupIdMap[se.superset_group_id]) groupIdMap[se.superset_group_id] = crypto.randomUUID()
  }

  // One id shared by the WHOLE batch (unlike groupIdMap above, which is
  // per superset sub-group within the batch) - this is what keeps the
  // section together as a single block in the drag-reorder UI from now on
  const sectionInstanceId = crypto.randomUUID()

  const { error: insertError } = await supabase.from('program_exercises').insert(
    sectionExercises.map((se, i) => ({
      day_id: dayId,
      exercise_id: se.exercise_id,
      order_index: baseOrder + i,
      prescribed_sets: se.prescribed_sets,
      prescribed_reps: se.prescribed_reps,
      prescribed_weight: se.prescribed_weight,
      rest_seconds: se.rest_seconds,
      extra_fields: se.extra_fields,
      set_targets: se.set_targets,
      notes: se.notes,
      section_label: sectionName,
      section_instance_id: sectionInstanceId,
      superset_group_id: se.superset_group_id ? groupIdMap[se.superset_group_id] : null
    }))
  )
  if (insertError) { console.log(insertError); customAlert('Something went wrong copying the exercises'); return }
}

// ==========================================================================
// ---- FORM TAB: list + preview + assign ----
// Same list-then-preview pattern as the Section tab, but assigning writes a
// form_assignments row directly - a form has no exercises to clone onto a
// program_day, it's a separate thing entirely that the athlete fills out.
// ==========================================================================
async function getFormsListCal() {
  if (cachedFormsCal) return cachedFormsCal
  const { data, error } = await window.fetchWithRetry((signal) => supabase.from('forms').select('*').order('name').abortSignal(signal))
  if (error) { console.log(error); customAlert('Something went wrong loading your forms - check your connection and try again'); return null }
  cachedFormsCal = data
  return cachedFormsCal
}

function resetFormPreviewCal() {
  selectedFormIdCal = null
  selectedFormNameCal = null
  root.querySelector('#dayAddFormPreview').innerHTML = '<p class="no-metrics">Select a form to preview it</p>'
  root.querySelector('#selectFormForDayBtn').disabled = true
}

async function loadDayAddFormListCal() {
  const data = await getFormsListCal()
  const list = root.querySelector('#dayAddFormList')

  if (data === null) {
    list.innerHTML = '<p class="no-metrics">Something went wrong loading your Forms</p>'
  } else if (data.length === 0) {
    list.innerHTML = '<p class="no-metrics">No forms saved yet - create one in Forms first</p>'
  } else {
    list.innerHTML = data.map(f => `
      <div class="training-pick-row" data-id="${f.id}" data-name="${f.name}">
        <span>${f.name}</span>
      </div>
    `).join('')

    list.querySelectorAll('.training-pick-row').forEach(row => {
      row.addEventListener('click', function() {
        list.querySelectorAll('.training-pick-row').forEach(r => r.classList.remove('selected'))
        row.classList.add('selected')
        previewFormCal(row.dataset.id, row.dataset.name)
      })
    })
  }
}

async function previewFormCal(formId, formName) {
  selectedFormIdCal = formId
  selectedFormNameCal = formName
  root.querySelector('#selectFormForDayBtn').disabled = false

  const preview = root.querySelector('#dayAddFormPreview')
  preview.innerHTML = '<p class="no-metrics">Loading…</p>'

  let questions = cachedFormQuestionsCal[formId]
  if (!questions) {
    const { data, error } = await supabase.from('form_questions').select('*').eq('form_id', formId).order('order_index')
    if (error) { console.log(error); preview.innerHTML = '<p class="no-metrics">Something went wrong loading this preview</p>'; return }
    questions = data
    cachedFormQuestionsCal[formId] = questions
  }

  if (selectedFormIdCal !== formId) return

  const form = (cachedFormsCal || []).find(f => f.id === formId)

  preview.innerHTML = `
    <div class="workout-preview-header">
      <h3>${escapeHtmlCal(formName)}</h3>
      <span class="workout-preview-count">${questions.length} Question${questions.length === 1 ? '' : 's'}</span>
    </div>
    ${form && form.gate_workout ? '<p class="form-gate-notice"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.29 3.86l-8.18 14.18A2 2 0 0 0 4 21h16a2 2 0 0 0 1.89-2.96L13.71 3.86a2 2 0 0 0-3.42 0z"></path></svg> Gates that day\'s workout until completed</p>' : ''}
    ${questions.length === 0
      ? '<p class="no-metrics">No questions in this form</p>'
      : questions.map(q => `<div class="workout-preview-exercise"><span>${escapeHtmlCal(q.question_text) || '<em>(untitled question)</em>'}</span></div>`).join('')}
  `
}

// ==========================================================================
// ---- DURATION + EXTRA FIELD HELPERS ----
// Still needed by the always-editable scheduled-exercise card
// (renderScheduledExerciseCard/saveScheduledExercise above) even though the
// calendar no longer has its own exercise picker - editing what's already
// on a day is still supported.
// ==========================================================================

function addExtraFieldRowCal(containerId, name, value) {
  const container = root.querySelector('#' + containerId)
  const row = document.createElement('div')
  row.className = 'extra-field-row'
  row.innerHTML = `
    <input type="text" class="extra-field-name" placeholder="Field name (e.g. RPE)" value="${name || ''}">
    <input type="text" class="extra-field-value" placeholder="Value (e.g. 8)" value="${value || ''}">
    <button type="button" class="extra-field-remove">✕</button>
  `
  row.querySelector('.extra-field-remove').addEventListener('click', function() { row.remove() })
  container.appendChild(row)
}

function collectExtraFieldsCal(containerId) {
  const rows = root.querySelectorAll('#' + containerId + ' .extra-field-row')
  const result = {}
  rows.forEach(row => {
    const name = row.querySelector('.extra-field-name').value.trim()
    const value = row.querySelector('.extra-field-value').value.trim()
    if (name && value) result[name] = value
  })
  return Object.keys(result).length ? result : null
}

// ==========================================================================
// ---- PER-SET TARGETS ----
// Same shape/reasoning as training-builder.js / program-builder.js: a
// program_exercises row keeps one set_targets array
// ([{reps, weight, rest, type}, ...], index 0 = Set 1) so each set can have
// its own target AND its own rest afterward (shorter between warmup sets
// than top sets) and its own type (warmup / main / failure), with
// prescribed_sets/prescribed_reps/prescribed_weight/rest_seconds kept in
// sync (length / first set's values) so every other place that only reads
// those old columns keeps working untouched.
// ==========================================================================
const SET_TYPES_CAL = { main: 'Main Set', warmup: 'Warmup Set', failure: 'Set to Failure' }

function deriveSetTargetsCal(row) {
  if (row.set_targets && row.set_targets.length) return row.set_targets
  const count = row.prescribed_sets || 1
  return Array.from({ length: count }, () => ({ reps: row.prescribed_reps || null, weight: row.prescribed_weight || null, rest: row.rest_seconds || null, type: 'main' }))
}

// Splits any previously-stored timed value into {mm, ss} so the mm:ss input
// boxes can be prefilled - handles the "M:SS" format this app now saves,
// old plain-seconds strings ("45") from before this change, and a
// best-effort digit grab for anything else free-typed in the past ("45s")
function parseTimeToParts(val) {
  if (val == null || val === '') return { mm: 0, ss: 0 }
  const str = String(val).trim()
  const mmss = str.match(/^(\d+):(\d{1,2})$/)
  if (mmss) return { mm: parseInt(mmss[1]), ss: Math.min(parseInt(mmss[2]), 59) }
  if (/^\d+$/.test(str)) {
    const total = parseInt(str)
    return { mm: Math.floor(total / 60), ss: total % 60 }
  }
  const digits = str.match(/\d+/)
  return digits ? { mm: 0, ss: Math.min(parseInt(digits[0]), 59) } : { mm: 0, ss: 0 }
}

function renderSetTargetRowCal(setNumber, target, tracksReps, isTimed, tracksWeight, isUnilateral, tracksDistance, onlyRow) {
  const repsPlaceholder = 'reps' + (isUnilateral ? ' each side' : '')
  // Legacy rows (saved back when Timed replaced Reps instead of coexisting
  // with it) stored the duration IN the reps field - fall back to reading
  // it from there, but only when reps isn't ALSO being tracked, so a real
  // rep count can never get misread as a duration once both are on.
  const durationSource = target.duration != null ? target.duration : (isTimed && !tracksReps ? target.reps : null)
  const { mm, ss } = parseTimeToParts(durationSource)
  const restParts = parseTimeToParts(target.rest)
  return `
    <div class="set-target-row" data-set-number="${setNumber}">
      <span class="set-label">Set ${setNumber}</span>
      <select class="set-type-select">
        ${Object.entries(SET_TYPES_CAL).map(([value, label]) => `<option value="${value}" ${(target.type || 'main') === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      ${tracksReps ? `<input type="text" class="set-reps-input" value="${target.reps || ''}" placeholder="${repsPlaceholder}">` : ''}
      ${isTimed ? `
        <div class="set-time-group" title="Time - minutes:seconds">
          <span class="set-time-group-label">Time</span>
          <div class="set-time-input">
            <input type="text" inputmode="numeric" class="set-time-mm" value="${String(mm).padStart(2, '0')}" maxlength="2">
            <span class="set-time-sep">:</span>
            <input type="text" inputmode="numeric" class="set-time-ss" value="${String(ss).padStart(2, '0')}" maxlength="2">
          </div>
        </div>
      ` : ''}
      ${tracksWeight ? `<input type="number" class="set-weight-input" value="${target.weight != null ? target.weight : ''}" placeholder="kg" step="0.5">` : ''}
      ${tracksDistance ? `<input type="number" class="set-distance-input" value="${target.distance != null ? target.distance : ''}" placeholder="meters" step="1">` : ''}
      <div class="set-time-group" title="Rest - minutes:seconds">
        <span class="set-time-group-label">Rest</span>
        <div class="set-time-input">
          <input type="text" inputmode="numeric" class="set-time-mm set-rest-mm" value="${String(restParts.mm).padStart(2, '0')}" maxlength="2">
          <span class="set-time-sep">:</span>
          <input type="text" inputmode="numeric" class="set-time-ss set-rest-ss" value="${String(restParts.ss).padStart(2, '0')}" maxlength="2">
        </div>
      </div>
      <button type="button" class="set-remove-btn" data-action="remove-set" ${onlyRow ? 'disabled' : ''}>✕</button>
    </div>
  `
}

// A superset is performed as one shared round, so its exercises can't
// drift to different set counts - every other card linked to this one
// (same superset_group_id, same day), if any.
function linkedCardsForCal(card, dayScopeEl) {
  const groupId = card.dataset.supersetGroupId
  if (!groupId || !dayScopeEl) return []
  return [...dayScopeEl.querySelectorAll(`.builder-exercise-card[data-superset-group-id="${groupId}"]`)].filter(c => c !== card)
}

// Reads a set row's current (possibly-edited) field values, so a new set
// added below it starts from what's already there instead of always blank -
// an untouched row's inputs are still at their blank defaults, so this
// naturally stays blank too when nothing was filled in yet.
function readSetRowValuesCal(rowEl) {
  if (!rowEl) return { reps: null, duration: null, weight: null, rest: null, distance: null, type: 'main' }
  const repsInput = rowEl.querySelector('.set-reps-input')
  const weightInput = rowEl.querySelector('.set-weight-input')
  const distanceInput = rowEl.querySelector('.set-distance-input')
  const typeSelect = rowEl.querySelector('.set-type-select')
  const timeMm = rowEl.querySelector('.set-time-mm:not(.set-rest-mm)')
  const timeSs = rowEl.querySelector('.set-time-ss:not(.set-rest-ss)')
  const restMm = rowEl.querySelector('.set-rest-mm')
  const restSs = rowEl.querySelector('.set-rest-ss')
  return {
    reps: repsInput ? repsInput.value : null,
    duration: timeMm ? `${timeMm.value}:${timeSs.value}` : null,
    weight: weightInput && weightInput.value !== '' ? weightInput.value : null,
    distance: distanceInput && distanceInput.value !== '' ? distanceInput.value : null,
    rest: restMm ? `${restMm.value}:${restSs.value}` : null,
    type: typeSelect ? typeSelect.value : 'main'
  }
}

function addSetTargetRowCal(rowsEl, tracksReps, isTimed, tracksWeight, isUnilateral, tracksDistance) {
  const rows = [...rowsEl.querySelectorAll('.set-target-row')]
  if (rows.length === 1) rows[0].querySelector('.set-remove-btn').disabled = false
  const carryOver = readSetRowValuesCal(rows[rows.length - 1])
  rowsEl.insertAdjacentHTML('beforeend', renderSetTargetRowCal(rows.length + 1, carryOver, tracksReps, isTimed, tracksWeight, isUnilateral, tracksDistance, false))
}

// Removal can happen from the middle of the list, so every remaining row
// needs relabelling, not just a length check
function removeSetTargetRowCal(row) {
  const rowsEl = row.parentElement
  row.remove()
  const remaining = [...rowsEl.querySelectorAll('.set-target-row')]
  remaining.forEach((r, i) => {
    r.dataset.setNumber = i + 1
    r.querySelector('.set-label').textContent = `Set ${i + 1}`
  })
  if (remaining.length === 1) remaining[0].querySelector('.set-remove-btn').disabled = true
}

function getYouTubeEmbedUrlCal(url) {
  if (!url) return null
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  return match ? `https://www.youtube.com/embed/${match[1]}?autoplay=1` : null
}

// Tapping a card's thumbnail swaps it for a playing embed right in place,
// same as the athlete's own exercise card
function playInlineVideoCal(containerEl, url) {
  if (!url) return
  const embedUrl = getYouTubeEmbedUrlCal(url)
  if (!embedUrl) { window.open(url, '_blank'); return }
  containerEl.innerHTML = `<iframe src="${embedUrl}" allow="autoplay; encrypted-media" allowfullscreen></iframe>`
}

// ==========================================================================
// ---- ASSIGN PROGRAM ----
// Clones a SLICE of a template's weeks/days/exercises tree (rangeStart to
// rangeEnd, both "Day N" counting straight through the whole program) into
// a brand new set of rows owned by this athlete - a real copy, not a live
// link, so editing the template later never changes an already-assigned
// athlete's calendar. Reached only through the "+" popup's Program tab
// (see the saveDayAddProgramBtn handler in bindCalendarStaticEvents).
// ==========================================================================

// Not wrapped in a database transaction - a failure partway through leaves
// a partial clone. Since programs -> program_weeks -> program_days ->
// program_exercises all cascade-delete, recovery is just deleting that one
// programs row and retrying.
async function cloneTemplateToAthlete(templateId, startDate, rangeStart, rangeEnd) {
  // These 2 don't depend on each other's results, so they fire together
  const [
    { data: template, error: templateError },
    { data: weeks, error: weeksError }
  ] = await Promise.all([
    supabase.from('programs').select('*').eq('id', templateId).single(),
    supabase.from('program_weeks').select('*, program_days(*, program_exercises(*))').eq('program_id', templateId)
  ])
  if (templateError) throw templateError
  if (weeksError) throw weeksError

  // startDate is the calendar day that was clicked to open this popup, and
  // it's always meant to line up with rangeStart (day 1 of whatever slice
  // was picked) - resolveDate() always counts from the program's own day 1,
  // so the new program's start_date has to be shifted back by
  // (rangeStart - 1) days for that day to land on startDate. Reusing
  // resolveDate() itself for this (week 1, day "2 - rangeStart") instead of
  // separate date-math: with week=1 it reduces to startDate + (day - 1),
  // and day = 2 - rangeStart gives startDate - (rangeStart - 1).
  const newStartDate = resolveDate(startDate, 1, 2 - rangeStart)

  const { data: newProgram, error: programError } = await supabase
    .from('programs')
    .insert([{
      coach_id: coachId(),
      athlete_id: athleteId,
      is_template: false,
      is_adhoc: false,
      name: template.name,
      start_date: newStartDate
    }])
    .select()
  if (programError) throw programError
  const newProgramId = newProgram[0].id

  weeks.sort((a, b) => a.week_number - b.week_number)

  // Only weeks that have at least one day inside the picked range
  const weeksInRange = weeks
    .map(week => ({
      week,
      days: [...week.program_days]
        .filter(day => {
          const linearDay = (week.week_number - 1) * 7 + day.day_number
          return linearDay >= rangeStart && linearDay <= rangeEnd
        })
        .sort((a, b) => a.day_number - b.day_number)
    }))
    .filter(w => w.days.length > 0)

  if (weeksInRange.length === 0) return

  // ---- Bulk-insert every week, then every day, then every exercise, one
  // insert call per table instead of one insert call per row - a 12-week
  // program used to mean 100+ sequential round-trips here, now it's 3-4.
  // Rows are matched back up to their new parent by a real key (week_number,
  // then week_id+day_number) rather than by array position, since a bulk
  // insert's response order isn't something to rely on. ----
  const { data: newWeeks, error: weeksInsertError } = await supabase
    .from('program_weeks')
    .insert(weeksInRange.map(w => ({ program_id: newProgramId, week_number: w.week.week_number })))
    .select()
  if (weeksInsertError) throw weeksInsertError

  const newWeekIdByNumber = {}
  newWeeks.forEach(w => { newWeekIdByNumber[w.week_number] = w.id })

  const dayRows = [] // flat list of { weekNumber, day } - remembers which template day each planned insert came from
  weeksInRange.forEach(w => {
    w.days.forEach(day => { dayRows.push({ weekNumber: w.week.week_number, day }) })
  })

  const { data: newDays, error: daysInsertError } = await supabase
    .from('program_days')
    .insert(dayRows.map(r => ({
      week_id: newWeekIdByNumber[r.weekNumber],
      day_number: r.day.day_number,
      label: r.day.label
    })))
    .select()
  if (daysInsertError) throw daysInsertError

  const newDayIdByKey = {}
  newDays.forEach(d => { newDayIdByKey[`${d.week_id}:${d.day_number}`] = d.id })

  // A template built with a Section or superset inside it carries
  // section_label/section_instance_id/superset_group_id on its own
  // program_exercises rows - this clone path was written before any of
  // that existed and never copied them over, so assigning such a template
  // silently dropped every section/superset link. Fresh id per distinct
  // value found across the whole template (all weeks), same reasoning as
  // every other clone-with-remap function above - so assigning the same
  // template more than once never makes two different assignments'
  // exercises look linked to each other.
  const groupIdMap = {}
  const sectionInstanceMap = {}
  dayRows.forEach(r => {
    r.day.program_exercises.forEach(pe => {
      if (pe.superset_group_id && !groupIdMap[pe.superset_group_id]) groupIdMap[pe.superset_group_id] = crypto.randomUUID()
      if (pe.section_instance_id && !sectionInstanceMap[pe.section_instance_id]) sectionInstanceMap[pe.section_instance_id] = crypto.randomUUID()
    })
  })

  const exerciseRows = []
  dayRows.forEach(r => {
    const newDayId = newDayIdByKey[`${newWeekIdByNumber[r.weekNumber]}:${r.day.day_number}`]
    const exercisesInDay = [...r.day.program_exercises].sort((a, b) => a.order_index - b.order_index)
    exercisesInDay.forEach(pe => {
      exerciseRows.push({
        day_id: newDayId,
        exercise_id: pe.exercise_id,
        order_index: pe.order_index,
        prescribed_sets: pe.prescribed_sets,
        prescribed_reps: pe.prescribed_reps,
        prescribed_weight: pe.prescribed_weight,
        rest_seconds: pe.rest_seconds,
        extra_fields: pe.extra_fields,
        set_targets: pe.set_targets,
        notes: pe.notes,
        section_label: pe.section_label,
        section_instance_id: pe.section_instance_id ? sectionInstanceMap[pe.section_instance_id] : null,
        superset_group_id: pe.superset_group_id ? groupIdMap[pe.superset_group_id] : null,
        // Carry any per-instance "Adjust Fields" overrides forward too -
        // assigning a template shouldn't silently drop them
        tracks_weight_override: pe.tracks_weight_override,
        is_timed_override: pe.is_timed_override,
        is_unilateral_override: pe.is_unilateral_override,
        tracks_distance_override: pe.tracks_distance_override,
        alternative_exercise_id: pe.alternative_exercise_id
      })
    })
  })

  if (exerciseRows.length > 0) {
    const { error: exercisesInsertError } = await supabase.from('program_exercises').insert(exerciseRows)
    if (exercisesInsertError) throw exercisesInsertError
  }
}

// Any set field, note, or extra-field value - autosave the owning card a
// moment after the coach stops typing (see scheduleAutosaveCal above)
const AUTOSAVE_FIELD_SELECTOR_CAL = '.set-reps-input, .set-weight-input, .set-distance-input, .set-time-mm, .set-time-ss, .exercise-notes-input, .extra-field-value'

// ==========================================================================
// ---- CALENDAR TAB: STATIC EVENT WIRING ----
// Everything athlete-calendar.js registered at module top-level, against
// markup that was already in the document on that page. Called once from
// bindEvents() (see mount()) - every element referenced here is part of the
// static TEMPLATE (the calendar toolbar, the Day Detail/Add Training/Day
// Picker/New Training/Training Builder modals, the copy-armed bar), not
// anything regenerated per render, so this only ever needs to run once.
// ==========================================================================
function bindCalendarStaticEvents() {
  root.querySelector('#calPrevBtn').addEventListener('click', function() {
    currentViewMonth--
    if (currentViewMonth < 0) { currentViewMonth = 11; currentViewYear-- }
    loadCalendarMonth(currentViewYear, currentViewMonth)
  })

  root.querySelector('#calNextBtn').addEventListener('click', function() {
    currentViewMonth++
    if (currentViewMonth > 11) { currentViewMonth = 0; currentViewYear++ }
    loadCalendarMonth(currentViewYear, currentViewMonth)
  })

  const dayDetailContent = root.querySelector('#dayDetailContent')

  dayDetailContent.addEventListener('click', async function(e) {
    const thumbBtn = e.target.closest('.builder-exercise-thumb')
    if (thumbBtn && thumbBtn.dataset.videoUrl) {
      playInlineVideoCal(thumbBtn, thumbBtn.dataset.videoUrl)
      return
    }

    const btn = e.target.closest('[data-action]')
    if (!btn) return

    if (btn.dataset.action === 'save-scheduled-day') {
      await saveScheduledDay(btn.closest('.detail-group'))
      return
    }

    if (btn.dataset.action === 'toggle-review-edit') {
      const dayId = btn.closest('.detail-group').dataset.programDayId
      openWorkoutBuilderOverlay(dayId, currentDayDateForModal)
      return
    }

    const card = btn.closest('.builder-exercise-card')
    const peId = card ? card.dataset.id : null

    if (btn.dataset.action === 'delete-scheduled') {
      await deleteScheduledExercise(peId)
    } else if (btn.dataset.action === 'add-set') {
      const pe = findScheduledPE(peId)
      addSetTargetRowCal(
        card.querySelector('.set-target-rows'),
        !!(pe && (!pe.exercises || pe.exercises.tracks_reps !== false)),
        !!(pe && pe.exercises && pe.exercises.is_timed),
        !!(pe && (!pe.exercises || pe.exercises.tracks_weight)),
        !!(pe && pe.exercises && pe.exercises.is_unilateral),
        !!(pe && pe.exercises && pe.exercises.tracks_distance)
      )
      scheduleAutosaveCal(peId)
      const dayScopeEl = card.closest('.detail-group')
      for (const other of linkedCardsForCal(card, dayScopeEl)) {
        const oPe = findScheduledPE(other.dataset.id)
        addSetTargetRowCal(
          other.querySelector('.set-target-rows'),
          !!(oPe && (!oPe.exercises || oPe.exercises.tracks_reps !== false)),
          !!(oPe && oPe.exercises && oPe.exercises.is_timed),
          !!(oPe && (!oPe.exercises || oPe.exercises.tracks_weight)),
          !!(oPe && oPe.exercises && oPe.exercises.is_unilateral),
          !!(oPe && oPe.exercises && oPe.exercises.tracks_distance)
        )
        scheduleAutosaveCal(other.dataset.id)
      }
    } else if (btn.dataset.action === 'remove-set') {
      const row = btn.closest('.set-target-row')
      const setNumber = row.dataset.setNumber
      removeSetTargetRowCal(row)
      scheduleAutosaveCal(peId)
      const dayScopeEl = card.closest('.detail-group')
      for (const other of linkedCardsForCal(card, dayScopeEl)) {
        const otherRow = other.querySelector(`.set-target-row[data-set-number="${setNumber}"]`)
        if (otherRow && other.querySelectorAll('.set-target-row').length > 1) {
          removeSetTargetRowCal(otherRow)
          scheduleAutosaveCal(other.dataset.id)
        }
      }
    } else if (btn.dataset.action === 'add-extra-field') {
      addExtraFieldRowCal(`extraFieldsSched-${peId}`)
    } else if (btn.dataset.action === 'toggle-link') {
      handleLinkClickCal(peId, btn.closest('.detail-group'))
    }
  })

  // mm:ss time boxes: strip anything non-digit as it's typed, then pad back
  // to 2 digits (and clamp seconds to 59) once the coach taps away. Selects
  // the "00" on focus so typing a digit replaces it instead of needing a
  // manual delete first
  dayDetailContent.addEventListener('focusin', function(e) {
    if (e.target.matches('.set-time-mm, .set-time-ss')) {
      e.target.select()
    }
  })
  dayDetailContent.addEventListener('input', function(e) {
    if (e.target.matches('.set-time-mm, .set-time-ss')) {
      e.target.value = e.target.value.replace(/\D/g, '').slice(0, 2)
    }
  })
  dayDetailContent.addEventListener('focusout', function(e) {
    if (e.target.matches('.set-time-mm, .set-time-ss')) {
      const max = e.target.classList.contains('set-time-ss') ? 59 : 99
      const val = Math.min(parseInt(e.target.value) || 0, max)
      e.target.value = String(val).padStart(2, '0')
    }
  })

  dayDetailContent.addEventListener('input', function(e) {
    if (!e.target.matches(AUTOSAVE_FIELD_SELECTOR_CAL)) return
    const card = e.target.closest('.builder-exercise-card')
    if (card) scheduleAutosaveCal(card.dataset.id)
  })
  dayDetailContent.addEventListener('change', async function(e) {
    if (e.target.matches('.set-type-select')) {
      const card = e.target.closest('.builder-exercise-card')
      if (card) scheduleAutosaveCal(card.dataset.id)
      return
    }

    if (e.target.matches('[data-action="set-workout-type"]')) {
      const dayId = e.target.dataset.dayId
      const { error } = await supabase.from('program_days').update({ workout_type: e.target.value }).eq('id', dayId)
      if (error) { console.log(error); customAlert('Something went wrong'); return }
      const entry = (calendarEntriesByDate[currentDayDateForModal] || []).find(en => en.day.id === dayId)
      if (entry) entry.day.workout_type = e.target.value
      renderCalendarGrid(currentViewYear, currentViewMonth)
    }
  })

  // ---- Reorder exercises within a day-entry group by dragging the ⠿
  // handle ---- Purely a DOM reorder while dragging (no network call),
  // scoped to stay within the same group - the new order is only written
  // to order_index when that group's own Save button is pressed, same as
  // every other edit here. Dragging between different day-entry groups
  // isn't supported. Grabbing any member of a section drags the whole
  // section together - see dataset.sectionInstanceId grouping below -
  // since the whole point of a section is that it stays together.
  dayDetailContent.addEventListener('dragstart', function(e) {
    const handle = e.target.closest('.builder-drag-handle')
    if (!handle) return
    const card = handle.closest('.builder-exercise-card')
    draggingGroupCal = card.closest('.detail-group')
    const instanceId = card.dataset.sectionInstanceId
    draggingCardsCal = instanceId
      ? [...draggingGroupCal.querySelectorAll(`.builder-exercise-card[data-section-instance-id="${instanceId}"]`)]
      : [card]
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', '')
    e.dataTransfer.setDragImage(card, 20, 20)
    setTimeout(function() { draggingCardsCal.forEach(c => c.classList.add('dragging')) }, 0)
  })

  dayDetailContent.addEventListener('dragover', function(e) {
    if (!draggingCardsCal.length) return
    if (e.target.closest('.detail-group') !== draggingGroupCal) return
    e.preventDefault()

    // Only a standalone card, or the FIRST card of a stationary section,
    // counts as a valid drop-target boundary - this is what makes it
    // impossible to drop in the middle of someone else's section
    const cards = [...draggingGroupCal.querySelectorAll('.builder-exercise-card:not(.dragging)')]
    const unitLeaders = cards.filter(function(c) {
      const id = c.dataset.sectionInstanceId
      if (!id) return true
      const prev = c.previousElementSibling
      return !prev || prev.dataset.sectionInstanceId !== id
    })
    const after = unitLeaders.reduce(function(closest, card) {
      const box = card.getBoundingClientRect()
      const offset = e.clientY - box.top - box.height / 2
      return (offset < 0 && offset > closest.offset) ? { offset, element: card } : closest
    }, { offset: -Infinity, element: null }).element

    if (after) {
      draggingCardsCal.forEach(c => draggingGroupCal.insertBefore(c, after))
    } else {
      const saveBtn = draggingGroupCal.querySelector('[data-action="save-scheduled-day"]')
      if (saveBtn) draggingCardsCal.forEach(c => draggingGroupCal.insertBefore(c, saveBtn))
      else draggingCardsCal.forEach(c => draggingGroupCal.appendChild(c))
    }
  })

  dayDetailContent.addEventListener('dragend', function() {
    draggingCardsCal.forEach(c => c.classList.remove('dragging'))
    draggingCardsCal = []
    draggingGroupCal = null
  })

  root.querySelector('#closeDayDetailBtn').addEventListener('click', function() {
    root.querySelector('#dayDetailModal').classList.remove('active')
  })

  root.querySelector('#selectTrainingForDayBtn').addEventListener('click', async function() {
    if (!selectedTrainingId) return
    const btn = this
    btn.disabled = true
    btn.textContent = 'Adding...'
    await applyTrainingToDay(selectedTrainingId, selectedTrainingName, currentDayDateForAddTraining)
    btn.textContent = 'Select'
  })

  root.querySelector('#dayAddTabWorkout').addEventListener('click', function() { switchDayAddTab('workout') })
  root.querySelector('#dayAddTabProgram').addEventListener('click', function() { switchDayAddTab('program') })
  root.querySelector('#dayAddTabSection').addEventListener('click', function() { switchDayAddTab('section') })
  root.querySelector('#dayAddTabForm').addEventListener('click', function() { switchDayAddTab('form') })

  root.querySelector('#programStartDayField').addEventListener('click', function() { openDayPicker('start') })
  root.querySelector('#programEndDayField').addEventListener('click', function() { openDayPicker('end') })
  root.querySelector('#dayPickerPrevBtn').addEventListener('click', function() { dayPickerPage--; renderDayPickerGrid() })
  root.querySelector('#dayPickerNextBtn').addEventListener('click', function() { dayPickerPage++; renderDayPickerGrid() })
  root.querySelector('#dayPickerCancelBtn').addEventListener('click', function() {
    root.querySelector('#dayPickerModal').classList.remove('active')
  })

  root.querySelector('#saveDayAddProgramBtn').addEventListener('click', async function() {
    if (!selectedTemplateId) { customAlert('Please choose a program'); return }

    const saveBtn = this
    saveBtn.disabled = true
    saveBtn.textContent = 'Assigning...'

    try {
      await cloneTemplateToAthlete(selectedTemplateId, currentDayDateForAddTraining, programStartDay, programEndDay)
      root.querySelector('#dayAddTrainingModal').classList.remove('active')
      await loadCalendarMonth(currentViewYear, currentViewMonth)
    } catch (err) {
      console.log(err)
      customAlert('Something went wrong while assigning the program. Check Supabase for a partially-created program under this athlete and delete it before retrying.')
    } finally {
      saveBtn.disabled = false
      saveBtn.textContent = 'Assign Program'
    }
  })

  root.querySelector('#closeDayAddTrainingBtn').addEventListener('click', function() {
    root.querySelector('#dayAddTrainingModal').classList.remove('active')
  })

  // ---- "+ New Training" - name it, then build it in an overlay without
  // leaving the calendar tab (training-builder.html loaded in an iframe) ----
  root.querySelector('#newTrainingFromDayBtn').addEventListener('click', function() {
    root.querySelector('#dayAddTrainingModal').classList.remove('active')
    root.querySelector('#newTrainingNameInput').value = ''
    root.querySelector('#newTrainingNameModal').classList.add('active')
  })

  root.querySelector('#cancelNewTrainingNameBtn').addEventListener('click', function() {
    root.querySelector('#newTrainingNameModal').classList.remove('active')
    openDayAddTrainingModal(currentDayDateForAddTraining)
  })

  root.querySelector('#saveNewTrainingNameBtn').addEventListener('click', async function() {
    const name = root.querySelector('#newTrainingNameInput').value.trim()
    if (!name) { customAlert('Please enter a name'); return }

    const { data, error } = await supabase
      .from('trainings')
      .insert([{ coach_id: coachId(), name }])
      .select()

    if (error) { console.log(error); customAlert('Something went wrong'); return }

    cachedTrainings = null // force a fresh fetch so the one just created shows up
    root.querySelector('#newTrainingNameModal').classList.remove('active')
    trainingBuilderOverlayMode = 'new-training'
    root.querySelector('#trainingBuilderFrame').src = `../training-builder.html?id=${data[0].id}&embed=1`
    root.querySelector('#trainingBuilderOverlayModal').classList.add('active')
  })

  // 'new-training': building a fresh Workout Library entry from the
  // day-add popup's "+ New" - Done goes back to that popup so the new one
  // can be selected. 'edit-day': adjusting an already-scheduled day's
  // exercises straight from its own calendar badge (see
  // openWorkoutBuilderOverlay) - Done just closes and refreshes the month,
  // there's no popup to return to. See trainingBuilderOverlayMode's own
  // declaration further up for the state var itself.
  root.querySelector('#doneTrainingBuilderBtn').addEventListener('click', async function() {
    root.querySelector('#trainingBuilderOverlayModal').classList.remove('active')
    root.querySelector('#trainingBuilderFrame').src = 'about:blank'
    if (trainingBuilderOverlayMode === 'edit-day') {
      await loadCalendarMonth(currentViewYear, currentViewMonth)
    } else {
      // Back to the day's training list, now including the one just built
      openDayAddTrainingModal(currentDayDateForAddTraining)
    }
  })

  root.querySelector('#copyArmedCancelBtn').addEventListener('click', disarmCopy)

  root.querySelector('#selectSectionForDayBtn').addEventListener('click', async function() {
    if (!selectedSectionIdCal) return
    const btn = this
    btn.disabled = true
    btn.textContent = 'Adding...'
    await applySectionToDayCal(selectedSectionIdCal, selectedSectionNameCal, currentDayDateForAddTraining)
    btn.textContent = 'Insert'
  })

  root.querySelector('#selectFormForDayBtn').addEventListener('click', async function() {
    if (!selectedFormIdCal) return
    const btn = this
    btn.disabled = true
    btn.textContent = 'Assigning...'

    const { error } = await supabase.from('form_assignments').insert([{
      coach_id: coachId(), athlete_id: athleteId, form_id: selectedFormIdCal, date: currentDayDateForAddTraining
    }])

    if (error) { console.log(error); customAlert('Something went wrong assigning that form'); btn.disabled = false; btn.textContent = 'Assign'; return }

    root.querySelector('#dayAddTrainingModal').classList.remove('active')
    btn.textContent = 'Assign'
    await loadCalendarMonth(currentViewYear, currentViewMonth)
  })
}

// ==========================================================================
// ---- SETTINGS TAB ----
// Per-athlete settings save immediately on change, no separate Save button -
// this screen is meant to be filled in once during onboarding and left alone.
// ==========================================================================
function bindSettingsEvents() {
  function bindToggle(id, field) {
    root.querySelector('#' + id).addEventListener('change', async function(e) {
      const { error } = await supabase
        .from('athletes')
        .update({ [field]: e.target.checked })
        .eq('id', athleteId)

      if (error) {
        console.log(error)
        customAlert('Something went wrong saving that setting')
        e.target.checked = !e.target.checked // revert the toggle visually
      }
    })
  }

  bindToggle('settingsNextWeekToggle', 'can_preview_next_week')
  bindToggle('settingsSelfLogToggle', 'can_self_log_workouts')
  bindToggle('settingsMobilityToggle', 'mobility_enabled')
  bindToggle('settingsTournamentsToggle', 'tournaments_enabled')
  bindToggle('settingsAddExercisesToggle', 'can_add_exercises')
  bindToggle('settingsChangeExercisesToggle', 'can_change_exercises')
  bindToggle('settingsRescheduleToggle', 'can_reschedule_workouts')
  bindToggle('settingsWeeklyStatsToggle', 'can_view_weekly_stats')
}

// ==========================================================================
// ---- STATUS + INVITE ACTIONS ----
// active = linked to a real login, pending = coach has entered an email but
// the athlete hasn't signed up/linked yet, offline = no email on file yet,
// archived = coach hid them (overrides the other 3 regardless of link state).
// Mirrors athleteStatus()/sendInviteEmail()/buildInviteLink() in
// screens/athletes.js - same shape, duplicated per this codebase's per-file
// convention (each screen module has no shared scope with another).
// ==========================================================================
function athleteStatus(athlete) {
  if (athlete.archived) return 'archived'
  if (athlete.user_id) return 'active'
  if (athlete.email) return 'pending'
  return 'offline'
}

const STATUS_LABELS = { active: 'Active', pending: 'Pending', offline: 'Offline', archived: 'Archived' }

function updateStatusUI(data) {
  const status = athleteStatus(data)
  const badge = root.querySelector('#profileStatusBadge')
  badge.textContent = STATUS_LABELS[status]
  badge.className = `athlete-status-badge status-${status}`

  root.querySelector('#editAthleteInviteActions').style.display = status === 'pending' ? 'flex' : 'none'
}

// athleteAppUrl exists because the app now lives at
// coach-app/dashboard.html instead of at the repo root - 'athlete-app/x'
// resolved against window.location.href would point at
// coach-app/athlete-app/x, which doesn't exist. Resolution happens against
// the loaded DOCUMENT's location, not this module's own file path - it
// makes no difference that this particular module lives one directory
// deeper (coach-app/screens/) than dashboard.html itself, since
// window.location.href is always coach-app/dashboard.html regardless of
// which screen module is running. One '../' reaches the repo root from
// there. Same fix, same reasoning, as screens/athletes.js's own invite flow.
function athleteAppUrl(page) {
  return new URL(`../athlete-app/${page}`, window.location.href).href
}

async function sendInviteEmail(email, name) {
  const redirectTo = athleteAppUrl('dashboard.html')
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true, emailRedirectTo: redirectTo, data: { role: 'athlete', name, needs_password: true } }
  })
  return error
}

function buildInviteLink(email, name) {
  const url = new URL('../athlete-app/index.html', window.location.href)
  if (email) url.searchParams.set('email', email)
  if (name) url.searchParams.set('name', name)
  return url.href
}

function bindStatusInviteEvents() {
  root.querySelector('#resendInviteBtn').addEventListener('click', async function() {
    if (!currentAthlete || !currentAthlete.email) return
    const error = await sendInviteEmail(currentAthlete.email, currentAthlete.name)
    customAlert(error ? 'Something went wrong sending the invite' : `Invite sent to ${currentAthlete.email}`)
  })

  root.querySelector('#copyInviteLinkBtn').addEventListener('click', async function() {
    if (!currentAthlete) return
    await navigator.clipboard.writeText(buildInviteLink(currentAthlete.email, currentAthlete.name))
    customAlert('Invite link copied - paste it anywhere you like.')
  })
}

// ==========================================================================
// ---- LOAD ATHLETE INFO ----
// Fetches the athlete's profile row. Split into a fetch-only loadAthlete()
// (called before TEMPLATE exists, same split screens/athletes.js uses for
// loadAthletes()/reloadAndRepaint()) and paintAthleteHeader(), which fills
// in the header/settings toggles once the real markup is in the DOM.
// ==========================================================================
async function loadAthlete(token) {
  const { data, error } = await window.fetchWithRetry((signal) => supabase
    .from('athletes')
    .select('*')
    .eq('id', athleteId)
    .single()
    .abortSignal(signal)
  )

  if (!nav.isCurrent(token)) return false

  if (error) {
    console.log('Error loading athlete:', error)
    if (root) {
      root.innerHTML = `
        <div class="screen-header">
          <button class="btn-back" id="athleteDetailBackBtn" aria-label="Back">←</button>
          <h2 class="screen-title">Athlete</h2>
        </div>
        <div class="screen-message">
          <h2>Couldn't load this athlete</h2>
          <p>Check your connection and try again.</p>
        </div>`
      root.querySelector('#athleteDetailBackBtn').addEventListener('click', function() { nav.back() })
    }
    return false
  }

  currentAthlete = data
  return true
}

// Fills in the profile header (name, initials, age, height, status badge),
// the browser tab title, and the Settings tab's toggles - everything
// loadAthlete() used to do inline once TEMPLATE existed on the page already.
function paintAthleteHeader() {
  const data = currentAthlete

  // Calculate age from date of birth
  const dob = new Date(data.date_of_birth)
  const age = Math.floor((new Date() - dob) / (365.25 * 24 * 60 * 60 * 1000))

  // Fill in profile header
  const initials = data.name.split(' ').map(w => w[0]).join('').toUpperCase()
  root.querySelector('#profileInitials').innerHTML = data.avatar_url
    ? `<img src="${data.avatar_url}" class="avatar-img" alt="">`
    : initials
  root.querySelector('#profileName').textContent = data.name
  root.querySelector('#profileDetails').textContent =
    `${data.gender} · ${age} years old · ${data.height}cm`
  updateStatusUI(data)

  document.title = `${data.name} — TBFlog`
  root.querySelector('#athleteDetailScreenTitle').textContent = data.name

  // Settings tab - populated here (not lazily) since it's just these
  // fields already loaded above, no chart-canvas-sizing concern like Metrics
  root.querySelector('#settingsNextWeekToggle').checked = !!data.can_preview_next_week
  root.querySelector('#settingsSelfLogToggle').checked = !!data.can_self_log_workouts
  root.querySelector('#settingsMobilityToggle').checked = !!data.mobility_enabled
  root.querySelector('#settingsTournamentsToggle').checked = !!data.tournaments_enabled
  root.querySelector('#settingsAddExercisesToggle').checked = !!data.can_add_exercises
  root.querySelector('#settingsChangeExercisesToggle').checked = !!data.can_change_exercises
  root.querySelector('#settingsRescheduleToggle').checked = !!data.can_reschedule_workouts
  root.querySelector('#settingsWeeklyStatsToggle').checked = !!data.can_view_weekly_stats
}

// ==========================================================================
// ---- OVERVIEW STATS: completion rate + volume ----
// Computed from this athlete's schedule (programs -> ... -> program_exercises)
// and their logged exercise_log_sets. Same nested-query shape and date math
// athlete-calendar.js/dashboard.js use, duplicated here since this screen
// (like every other one) has no shared scope with those.
// ==========================================================================
function toDateStrOv(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function parseDateStrOv(dateStr) {
  return new Date(dateStr + 'T00:00:00')
}

function resolveDateOv(startDateStr, weekNumber, dayNumber) {
  const start = parseDateStrOv(startDateStr)
  const result = new Date(start)
  result.setDate(result.getDate() + (weekNumber - 1) * 7 + (dayNumber - 1))
  return toDateStrOv(result)
}

function addDaysOv(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

function daysBetweenDateStrsOv(a, b) {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86400000)
}

function startOfWeekOv(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay() // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day // shift back to Monday
  d.setDate(d.getDate() + diff)
  return d
}

// Weight x reps for one logged set - 0 if incomplete, unweighted, or the
// reps didn't parse as a plain number (duration text, unedited "8-12" ranges)
function setVolumeOv(s) {
  if (!s.completed_at || s.actual_weight == null) return 0
  const reps = parseInt(s.actual_reps)
  return isNaN(reps) ? 0 : reps * s.actual_weight
}

// Same is_adhoc/label fallback used everywhere else a training's display
// name is derived (athlete-calendar.js half of this module, dashboard.js)
function trainingDisplayNameOv(program, day) {
  if (program.is_adhoc) return program.name || 'Workout'
  return day.label || ('Day ' + day.day_number)
}

function formatDurationOv(minutes) {
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

async function loadOverviewStatsGuarded() {
  if (overviewLoadInFlight) return
  overviewLoadInFlight = true
  try {
    await Promise.all([loadOverviewStats(), loadRecentActivity()])
  } finally {
    overviewLoadInFlight = false
  }
}

async function loadOverviewStats() {
  const ninetyDaysAgo = toDateStrOv(addDaysOv(new Date(), -89))
  const ninetyDaysAgoISO = addDaysOv(new Date(), -89).toISOString()
  const token = mountToken

  // These 3 queries don't depend on each other's results, so they fire
  // together instead of waiting on each other one at a time - this alone
  // cuts this tab's load time roughly in half to a third. Each also goes
  // through window.fetchWithRetry so a slow/flaky connection gets a couple
  // of automatic retries instead of these stats just staying blank with no
  // explanation.
  const [
    { data: programs, error: programsError },
    { data: logSets, error: logError },
    { data: sessions, error: sessionsError }
  ] = await Promise.all([
    window.fetchWithRetry((signal) => supabase
      .from('programs')
      .select('*, program_weeks(*, program_days(*, program_exercises(*, exercises!exercise_id(tracks_weight))))')
      .eq('athlete_id', athleteId)
      .eq('is_template', false)
      .abortSignal(signal)
    ),
    window.fetchWithRetry((signal) => supabase
      .from('exercise_log_sets')
      .select('*')
      .eq('athlete_id', athleteId)
      .gte('date', ninetyDaysAgo)
      .abortSignal(signal)
    ),
    window.fetchWithRetry((signal) => supabase
      .from('workout_sessions')
      .select('*')
      .eq('athlete_id', athleteId)
      .not('ended_at', 'is', null)
      .gte('started_at', ninetyDaysAgoISO)
      .order('started_at', { ascending: false })
      .abortSignal(signal)
    )
  ])

  if (!nav.isCurrent(token)) return
  if (programsError) { console.log('Error loading schedule for stats:', programsError); customAlert('Something went wrong loading this athlete\'s stats - check your connection and try again'); return }
  if (logError) { console.log('Error loading logged sets for stats:', logError); customAlert('Something went wrong loading this athlete\'s stats - check your connection and try again'); return }
  if (sessionsError) { console.log('Error loading sessions for stats:', sessionsError); customAlert('Something went wrong loading this athlete\'s stats - check your connection and try again'); return }
  if (!root) return

  // One entry per program_days row - i.e. per workout, not per calendar
  // date. Two workouts landing on the same date (an assigned program day
  // plus an ad-hoc training, say) stay separate here so completion rate
  // counts them as two workouts, not one merged day. dayInfoById remembers
  // each workout's date + display name so a workout_sessions row (which
  // only has a program_day_id) can be labeled in the duration list below.
  const workoutEntries = [] // { dateStr, exercises }
  const dayInfoById = {}
  // Every program_exercise whose underlying exercise tracks weight - volume
  // only makes sense for weight-bearing sets, so it's scoped to just these
  // (tracks_weight is independent of Timed/Plyometric now, so a weighted
  // timed hold still counts, but a bodyweight-only exercise doesn't)
  const weightsPEIds = new Set()
  for (const program of programs) {
    for (const week of program.program_weeks) {
      for (const day of week.program_days) {
        const dateStr = day.date_override || resolveDateOv(program.start_date, week.week_number, day.day_number)
        workoutEntries.push({ dateStr, exercises: day.program_exercises })
        dayInfoById[day.id] = { dateStr, name: trainingDisplayNameOv(program, day) }
        for (const pe of day.program_exercises) {
          // A per-instance "Adjust Fields" override (Workout Builder) wins
          // over the exercise's own tracks_weight default when present
          const tracksWeight = pe.tracks_weight_override != null ? pe.tracks_weight_override : !!(pe.exercises && pe.exercises.tracks_weight)
          if (tracksWeight) weightsPEIds.add(pe.id)
        }
      }
    }
  }

  const logSetsByPE = {}
  for (const row of logSets) {
    if (!logSetsByPE[row.program_exercise_id]) logSetsByPE[row.program_exercise_id] = []
    logSetsByPE[row.program_exercise_id].push(row)
  }

  // ---- Completion rate: scheduled workouts where at least half the
  // prescribed sets got logged, divided by scheduled workouts in the
  // window - counted per workout (per program_days row), not per calendar
  // date, so a day with two separate trainings counts as two, not one.
  // Set-level within a workout (not "every exercise finished") so 2 fully
  // done exercises plus 1 barely started still gets fair partial credit.
  // Workouts with no exercises don't count toward either side. Today's
  // workout(s) only count once actually done - the day isn't over yet, so
  // an unfinished/not-yet-started workout scheduled for today shouldn't
  // drag the rate down as if it had been missed.
  function completionRate(windowDays) {
    const cutoff = toDateStrOv(addDaysOv(new Date(), -(windowDays - 1)))
    const todayStr = toDateStrOv(new Date())
    let scheduled = 0
    let completed = 0

    for (const entry of workoutEntries) {
      if (entry.dateStr < cutoff || entry.dateStr > todayStr) continue
      if (entry.exercises.length === 0) continue

      let totalSets = 0
      let doneSets = 0
      for (const pe of entry.exercises) {
        const prescribed = pe.prescribed_sets || 1
        totalSets += prescribed
        const logged = (logSetsByPE[pe.id] || []).filter(s => s.completed_at && s.set_number <= prescribed)
        doneSets += Math.min(logged.length, prescribed)
      }
      const workoutDone = totalSets > 0 && (doneSets / totalSets) >= 0.5
      if (entry.dateStr === todayStr && !workoutDone) continue

      scheduled++
      if (workoutDone) completed++
    }

    return scheduled === 0 ? null : Math.round((completed / scheduled) * 100)
  }

  const rate30 = completionRate(30)
  const rate60 = completionRate(60)
  const rate90 = completionRate(90)

  root.querySelector('#statCompletion').textContent = rate30 === null ? '—' : `${rate30}%`
  root.querySelector('#statCompletion30').textContent = rate30 === null ? '—' : `${rate30}%`
  root.querySelector('#statCompletion60').textContent = rate60 === null ? '—' : `${rate60}%`
  root.querySelector('#statCompletion90').textContent = rate90 === null ? '—' : `${rate90}%`

  // ---- Volume (weights exercises only - see weightsPEIds above) ----
  const sevenDaysAgo = toDateStrOv(addDaysOv(new Date(), -6))
  const volume7d = logSets
    .filter(s => s.date >= sevenDaysAgo && weightsPEIds.has(s.program_exercise_id))
    .reduce((sum, s) => sum + setVolumeOv(s), 0)

  root.querySelector('#statVolume').textContent = `${Math.round(volume7d).toLocaleString()}kg`

  // Weekly buckets for the trend chart, oldest of the last 12 weeks first
  const weeklyVolume = {} // 'YYYY-MM-DD' (week start) -> kg
  for (const s of logSets) {
    if (!weightsPEIds.has(s.program_exercise_id)) continue
    const weekStart = toDateStrOv(startOfWeekOv(parseDateStrOv(s.date)))
    weeklyVolume[weekStart] = (weeklyVolume[weekStart] || 0) + setVolumeOv(s)
  }

  const labels = []
  const values = []
  const currentWeekStart = startOfWeekOv(new Date())
  for (let i = 11; i >= 0; i--) {
    const weekStart = addDaysOv(currentWeekStart, -7 * i)
    labels.push(weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))
    values.push(Math.round(weeklyVolume[toDateStrOv(weekStart)] || 0))
  }
  volumeChartData = { labels, values }

  // ---- Duration: completed workout_sessions rows only (still-open sessions
  // have no ended_at yet, nothing to measure) ----
  durationEvents = sessions.map(s => {
    const info = dayInfoById[s.program_day_id]
    const minutes = Math.round((new Date(s.ended_at) - new Date(s.started_at)) / 60000)
    return { dateStr: info ? info.dateStr : s.local_date, name: info ? info.name : 'Workout', minutes }
  })

  const thirtyDaysAgo = toDateStrOv(addDaysOv(new Date(), -29))
  const recentDurations = durationEvents.filter(e => e.dateStr >= thirtyDaysAgo).map(e => e.minutes)
  const avgMinutes = recentDurations.length
    ? Math.round(recentDurations.reduce((sum, m) => sum + m, 0) / recentDurations.length)
    : null

  root.querySelector('#statDuration').textContent = avgMinutes === null ? '—' : formatDurationOv(avgMinutes)

  // ---- Training Load (Foster's session-RPE method: RPE x duration) ----
  // sessions already covers a 90-day window with session_rpe included
  // (select('*') above) - no extra query needed.
  const dailyLoad = {} // dateStr -> summed session_load that day
  for (const s of sessions) {
    if (s.session_rpe == null) continue // no rating entered - excluded, not treated as 0
    const dateStr = s.local_date
    const minutes = (new Date(s.ended_at) - new Date(s.started_at)) / 60000
    dailyLoad[dateStr] = (dailyLoad[dateStr] || 0) + s.session_rpe * minutes
  }

  function loadSum(days) {
    const cutoff = toDateStrOv(addDaysOv(new Date(), -(days - 1)))
    const todayStr = toDateStrOv(new Date())
    return Object.entries(dailyLoad)
      .filter(([d]) => d >= cutoff && d <= todayStr)
      .reduce((sum, [, v]) => sum + v, 0)
  }

  // ACWR only means something once there's a real 4-week baseline to compare
  // against - with less than 28 days of rated-session history, loadSum(28)/4
  // divides a partial sum by 4 as if a full chronic period had passed,
  // understating the baseline and inflating the ratio. Held back as "—"
  // until enough history exists, rather than showing a falsely high number.
  const loadDates = Object.keys(dailyLoad).sort()
  daysOfLoadHistoryValue = loadDates.length ? daysBetweenDateStrsOv(loadDates[0], toDateStrOv(new Date())) + 1 : 0
  const hasEnoughHistoryForAcwr = daysOfLoadHistoryValue >= 28

  acuteLoadValue = loadSum(7)
  chronicLoadValue = hasEnoughHistoryForAcwr ? loadSum(28) / 4 : 0
  acwrValue = (hasEnoughHistoryForAcwr && chronicLoadValue > 0) ? acuteLoadValue / chronicLoadValue : null
  const highRisk = acwrValue !== null && acwrValue > 1.5

  // Rest days count as 0, not skipped - monotony measures variation across
  // the whole week, and a rest day lowering it is the entire point
  last7DailyLoad = []
  for (let i = 6; i >= 0; i--) {
    const dateStr = toDateStrOv(addDaysOv(new Date(), -i))
    last7DailyLoad.push({ dateStr, load: dailyLoad[dateStr] || 0 })
  }
  const mean7 = last7DailyLoad.reduce((sum, d) => sum + d.load, 0) / 7
  const stddev7 = Math.sqrt(last7DailyLoad.reduce((sum, d) => sum + (d.load - mean7) ** 2, 0) / 7)
  monotonyValue = stddev7 > 0 ? mean7 / stddev7 : null
  strainValue = monotonyValue !== null ? acuteLoadValue * monotonyValue : null

  root.querySelector('#statWeeklyLoad').textContent = acuteLoadValue > 0 ? Math.round(acuteLoadValue).toLocaleString() : '—'
  root.querySelector('#statAcwr').textContent = acwrValue === null ? '—' : acwrValue.toFixed(2)
  const acwrRiskBadge = root.querySelector('#statAcwrRisk')
  if (highRisk) {
    acwrRiskBadge.textContent = 'High Risk'
    acwrRiskBadge.className = 'stat-risk-badge'
    acwrRiskBadge.style.display = 'inline-block'
  } else if (!hasEnoughHistoryForAcwr && loadDates.length > 0) {
    acwrRiskBadge.textContent = 'Building History'
    acwrRiskBadge.className = 'stat-risk-badge neutral'
    acwrRiskBadge.style.display = 'inline-block'
  } else {
    acwrRiskBadge.style.display = 'none'
  }
  root.querySelector('#statMonotony').textContent = monotonyValue === null ? '—' : monotonyValue.toFixed(2)
  root.querySelector('#statStrain').textContent = strainValue === null ? '—' : Math.round(strainValue).toLocaleString()

  renderPainReports(sessions, dayInfoById)

  const updatedLabel = root.querySelector('#overviewUpdatedLabel')
  if (updatedLabel) updatedLabel.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// The Overview tab's pain/injury inbox - unreviewed reports only (see
// wireRpeFlagFollowup in athlete-app/dashboard.js for how these get set).
// Reuses the same 90-day `sessions` fetch loadOverviewStats already made -
// no extra query. Known limitation, same as every other stat on this tab:
// a report older than that window with no coach visit in the meantime
// ages out of this list silently.
function renderPainReports(sessions, dayInfoById) {
  const section = root.querySelector('#painReportsSection')
  const list = root.querySelector('#painReportsList')
  const reports = sessions.filter(s => s.rpe_flag_reason === 'pain_injury' && !s.rpe_flag_reviewed_at)

  if (reports.length === 0) {
    section.style.display = 'none'
    return
  }

  section.style.display = 'block'
  list.innerHTML = reports.map(s => {
    const info = dayInfoById[s.program_day_id]
    const dateStr = info ? info.dateStr : s.local_date
    const name = info ? info.name : 'Workout'
    return `
      <div class="pain-report-row">
        <div class="pain-report-meta">${formatDisplayDate(dateStr)} — ${name} · RPE ${s.session_rpe}/10</div>
        <p class="pain-report-note">${escapeHtml(s.rpe_flag_note) || '<em>No description given</em>'}</p>
        <button type="button" class="unit-btn pain-report-review-btn" data-session-id="${s.id}">Mark Reviewed</button>
      </div>
    `
  }).join('')

  list.querySelectorAll('.pain-report-review-btn').forEach(btn => {
    btn.addEventListener('click', async function() {
      const row = btn.closest('.pain-report-row')
      btn.disabled = true
      btn.textContent = 'Marking...'

      const { error } = await supabase
        .from('workout_sessions')
        .update({ rpe_flag_reviewed_at: new Date().toISOString() })
        .eq('id', btn.dataset.sessionId)

      if (error) {
        console.log(error)
        customAlert('Something went wrong - please try again')
        btn.disabled = false
        btn.textContent = 'Mark Reviewed'
        return
      }

      row.remove()
      if (list.children.length === 0) section.style.display = 'none'
    })
  })
}

// Only used for user-entered free text rendered via innerHTML (the
// pain/injury note above, and the tournament/workout names in the recent
// activity feed below) - every other string on this tab is either
// coach-authored or a fixed option, so this isn't applied everywhere
function escapeHtml(str) {
  if (!str) return ''
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

function bindOverviewEvents() {
  root.querySelector('#editAthleteBtn').addEventListener('click', function() {
    const data = currentAthlete
    root.querySelector('#editAthleteName').value = data.name
    root.querySelector('#editAthleteDOB').value = data.date_of_birth
    root.querySelector('#editAthleteGender').value = data.gender
    root.querySelector('#editAthleteHeight').value = data.height
    root.querySelector('#editAthleteEmail').value = data.email || ''
    root.querySelector('#editAthleteModal').classList.add('active')
  })

  root.querySelector('#refreshOverviewBtn').addEventListener('click', function() {
    loadOverviewStatsGuarded()
  })

  root.querySelector('#statDurationCard').addEventListener('click', function() {
    root.querySelector('#durationDetailModal').classList.add('active')
    renderDurationModal()
  })
  root.querySelector('#closeDurationModalBtn').addEventListener('click', function() {
    root.querySelector('#durationDetailModal').classList.remove('active')
  })

  root.querySelector('#statCompletionCard').addEventListener('click', function() {
    root.querySelector('#completionDetailModal').classList.add('active')
  })
  root.querySelector('#closeCompletionModalBtn').addEventListener('click', function() {
    root.querySelector('#completionDetailModal').classList.remove('active')
  })

  // Chart.js sizes its canvas from rendered pixel dimensions, so it's only
  // drawn once the modal is actually visible - same reasoning as the
  // Metrics tab's lazy chart loading. await loadChartJs() here means a
  // coach who opens this modal without ever visiting Metrics/Calendar still
  // triggers the Chart.js fetch - see this file's top banner comment.
  root.querySelector('#statVolumeCard').addEventListener('click', async function() {
    root.querySelector('#volumeDetailModal').classList.add('active')

    const canvas = root.querySelector('#volumeChart')
    const noDataMsg = root.querySelector('#noVolumeMsg')
    const hasData = volumeChartData.values.some(v => v > 0)

    if (!hasData) {
      canvas.style.display = 'none'
      noDataMsg.style.display = 'block'
      return
    }

    canvas.style.display = 'block'
    noDataMsg.style.display = 'none'

    await loadChartJs()
    if (!root) return

    if (volumeChart) volumeChart.destroy()

    volumeChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: volumeChartData.labels,
        datasets: [{
          data: volumeChartData.values,
          backgroundColor: '#4a4a8e'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#aaaacc', font: { size: 10 } }, grid: { display: false } },
          y: { ticks: { color: '#aaaacc', font: { size: 10 } }, grid: { color: '#2a2a4e' } }
        }
      }
    })
  })

  root.querySelector('#closeVolumeModalBtn').addEventListener('click', function() {
    root.querySelector('#volumeDetailModal').classList.remove('active')
  })

  // ---- Training Load modals ----
  root.querySelector('#statWeeklyLoadCard').addEventListener('click', function() {
    root.querySelector('#weeklyLoadDetailModal').classList.add('active')
    renderWeeklyLoadModal()
  })
  root.querySelector('#closeWeeklyLoadModalBtn').addEventListener('click', function() {
    root.querySelector('#weeklyLoadDetailModal').classList.remove('active')
  })

  root.querySelector('#statAcwrCard').addEventListener('click', function() {
    root.querySelector('#acwrDetailModal').classList.add('active')
    root.querySelector('#statAcuteLoad').textContent = acuteLoadValue > 0 ? Math.round(acuteLoadValue).toLocaleString() : '—'
    root.querySelector('#statChronicLoad').textContent = chronicLoadValue > 0 ? Math.round(chronicLoadValue).toLocaleString() : '—'
    root.querySelector('#statAcwrDetail').textContent = acwrValue === null ? '—' : acwrValue.toFixed(2)
    const acwrNote = root.querySelector('#acwrInsufficientNote')
    if (acwrValue === null && daysOfLoadHistoryValue > 0 && daysOfLoadHistoryValue < 28) {
      acwrNote.textContent = `Needs 28 days of rated training history to calculate a reliable ratio — ${daysOfLoadHistoryValue} day${daysOfLoadHistoryValue === 1 ? '' : 's'} so far.`
      acwrNote.style.display = 'block'
    } else {
      acwrNote.style.display = 'none'
    }
  })
  root.querySelector('#closeAcwrModalBtn').addEventListener('click', function() {
    root.querySelector('#acwrDetailModal').classList.remove('active')
  })

  root.querySelector('#statMonotonyCard').addEventListener('click', function() {
    root.querySelector('#monotonyDetailModal').classList.add('active')
  })
  root.querySelector('#closeMonotonyModalBtn').addEventListener('click', function() {
    root.querySelector('#monotonyDetailModal').classList.remove('active')
  })

  root.querySelector('#statStrainCard').addEventListener('click', function() {
    root.querySelector('#strainDetailModal').classList.add('active')
  })
  root.querySelector('#closeStrainModalBtn').addEventListener('click', function() {
    root.querySelector('#strainDetailModal').classList.remove('active')
  })
}

function renderWeeklyLoadModal() {
  const container = root.querySelector('#weeklyLoadList')
  container.innerHTML = `
    <ul class="detail-list">
      ${last7DailyLoad.map(d => `
        <li class="detail-row">
          <span>${d.dateStr}</span>
          <span class="detail-row-value">${d.load > 0 ? Math.round(d.load).toLocaleString() : '—'}</span>
        </li>
      `).join('')}
    </ul>
  `
}

function renderDurationModal() {
  const container = root.querySelector('#durationList')

  if (durationEvents.length === 0) {
    container.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No completed workouts logged yet</p>'
    return
  }

  container.innerHTML = `
    <ul class="detail-list">
      ${durationEvents.map(e => `
        <li class="detail-row">
          <span>${e.dateStr} — ${e.name}</span>
          <span class="detail-row-value">${formatDurationOv(e.minutes)}</span>
        </li>
      `).join('')}
    </ul>
  `
}

// ==========================================================================
// ---- RECENT ACTIVITY ----
// Last 5 things this athlete has done, merged from 3 otherwise-unrelated
// tables (there's no single activity-log table) - tournaments added, own
// workouts started, and workouts (incl. mobility sessions) completed. Each
// query is capped at 5 and independently the most recent of its own kind,
// so merging+sorting client-side and slicing the top 5 overall can never
// miss a genuinely-recent event in favor of a stale one from another table.
// ==========================================================================
function formatActivityDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

async function loadRecentActivity() {
  const token = mountToken
  const list = root.querySelector('#recentActivityList')

  const [
    { data: tournaments, error: tournamentsError },
    { data: ownPrograms, error: programsError },
    { data: sessions, error: sessionsError }
  ] = await Promise.all([
    window.fetchWithRetry((signal) => supabase
      .from('tournaments')
      .select('id, name, created_at')
      .eq('athlete_id', athleteId)
      .order('created_at', { ascending: false })
      .limit(5)
      .abortSignal(signal)
    ),
    window.fetchWithRetry((signal) => supabase
      .from('programs')
      .select('id, name, created_at')
      .eq('athlete_id', athleteId)
      .eq('created_by_athlete', true)
      .order('created_at', { ascending: false })
      .limit(5)
      .abortSignal(signal)
    ),
    window.fetchWithRetry((signal) => supabase
      .from('workout_sessions')
      .select('id, ended_at, session_type, program_days(day_number, label, program_weeks(programs(name, is_adhoc)))')
      .eq('athlete_id', athleteId)
      .not('ended_at', 'is', null)
      .order('ended_at', { ascending: false })
      .limit(5)
      .abortSignal(signal)
    )
  ])

  if (!nav.isCurrent(token)) return

  if (tournamentsError || programsError || sessionsError) {
    console.log('Error loading recent activity:', tournamentsError || programsError || sessionsError)
    list.innerHTML = '<p class="no-metrics">Something went wrong loading recent activity</p>'
    return
  }

  const trophyIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="7"></circle><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"></polyline></svg>'
  const dumbbellIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"></circle><circle cx="20" cy="12" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line><line x1="9" y1="8" x2="9" y2="16"></line><line x1="15" y1="8" x2="15" y2="16"></line></svg>'
  const mobilityIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4" r="2"></circle><path d="M12 6v6"></path><path d="M8 8l4 2 4-2"></path><path d="M9 20l3-6 3 6"></path></svg>'
  const checkIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>'

  const events = []
  for (const t of tournaments) {
    events.push({ at: t.created_at, icon: trophyIcon, text: `Added a tournament: ${escapeHtml(t.name)}` })
  }
  for (const p of ownPrograms) {
    events.push({ at: p.created_at, icon: dumbbellIcon, text: `Added their own workout${p.name ? ': ' + escapeHtml(p.name) : ''}` })
  }
  for (const s of sessions) {
    if (s.session_type === 'mobility') {
      events.push({ at: s.ended_at, icon: mobilityIcon, text: 'Completed a mobility session' })
      continue
    }
    const day = s.program_days
    const program = day && day.program_weeks && day.program_weeks.programs
    const name = program ? trainingDisplayNameOv(program, day) : 'a workout'
    events.push({ at: s.ended_at, icon: checkIcon, text: `Completed a workout: ${escapeHtml(name)}` })
  }

  events.sort((a, b) => b.at.localeCompare(a.at))
  const recent = events.slice(0, 5)

  list.innerHTML = recent.length === 0
    ? '<p class="no-metrics">No activity yet</p>'
    : recent.map(e => `
        <div class="activity-row">
          <span class="activity-icon-chip">${e.icon}</span>
          <span class="activity-text">${e.text}</span>
          <span class="activity-date">${formatActivityDate(e.at)}</span>
        </div>
      `).join('')
}

// ==========================================================================
// ---- ATHLETE NOTES ----
// Dated notes log: each "Add" creates a new row in athlete_notes (never
// overwrites), so past notes stay visible with the date they were written.
// Mirrors the Bodyweight pattern - a "latest entry" preview in the header,
// full history + edit/delete in the "View all" modal.
// (currentNoteEntry is declared once, up in the module state section above)
// ==========================================================================

// Formats a stored 'YYYY-MM-DD' date string as e.g. "Jul 23, 2026"
function formatDisplayDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// Shows the single most recent note in the profile header
async function loadLatestNote() {
  const token = mountToken
  const { data } = await supabase
    .from('athlete_notes')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: false })
    .limit(1)

  if (!nav.isCurrent(token)) return
  const preview = root.querySelector('#latestNotePreview')

  if (!data || data.length === 0) {
    preview.classList.add('no-notes')
    preview.innerHTML = '<p class="no-bodyweight-data">No notes yet</p>'
    return
  }

  const latest = data[0]
  preview.classList.remove('no-notes')
  preview.innerHTML = `
    <p class="latest-note-date">${formatDisplayDate(latest.date)}</p>
    <p class="latest-note-text">${latest.note}</p>
  `
}

// Fetches and renders every note for this athlete, newest first
async function loadNotesList() {
  const token = mountToken
  const { data } = await supabase
    .from('athlete_notes')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: false })

  if (!nav.isCurrent(token)) return
  const list = root.querySelector('#notesList')

  if (!data || data.length === 0) {
    list.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No notes yet</p>'
    return
  }

  list.innerHTML = data.map(n => `
    <div class="note-entry">
      <div class="note-entry-header">
        <span class="note-entry-date">${formatDisplayDate(n.date)}</span>
        <div>
          <button class="btn-edit-entry" data-note-id="${n.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg></button>
          <button class="btn-delete-measurement" data-note-id="${n.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
        </div>
      </div>
      <p class="note-entry-text">${n.note}</p>
    </div>
  `).join('')

  list.querySelectorAll('.btn-edit-entry').forEach(btn => {
    btn.addEventListener('click', function() {
      const noteId = parseInt(this.dataset.noteId)
      currentNoteEntry = data.find(n => n.id === noteId)
      root.querySelector('#editNoteDate').value = currentNoteEntry.date
      root.querySelector('#editNoteText').value = currentNoteEntry.note
      root.querySelector('#editNoteModal').classList.add('active')
    })
  })

  list.querySelectorAll('.btn-delete-measurement').forEach(btn => {
    btn.addEventListener('click', async function() {
      const noteId = parseInt(this.dataset.noteId)
      if (!(await customConfirm('Delete this note?'))) return

      const { error } = await supabase
        .from('athlete_notes')
        .delete()
        .eq('id', noteId)

      if (error) { customAlert('Something went wrong'); return }

      loadNotesList()
      loadLatestNote()
    })
  })
}

function bindNotesEvents() {
  root.querySelector('#addNoteBtn').addEventListener('click', function() {
    root.querySelector('#noteDate').valueAsDate = new Date()
    root.querySelector('#noteText').value = ''
    root.querySelector('#addNoteModal').classList.add('active')
  })

  root.querySelector('#closeAddNoteBtn').addEventListener('click', function() {
    root.querySelector('#addNoteModal').classList.remove('active')
  })

  root.querySelector('#cancelAddNoteBtn').addEventListener('click', function() {
    root.querySelector('#addNoteModal').classList.remove('active')
  })

  root.querySelector('#saveNoteBtn').addEventListener('click', async function() {
    const date = root.querySelector('#noteDate').value
    const note = root.querySelector('#noteText').value.trim()

    if (!date || !note) { customAlert('Please fill in date and note'); return }

    const { error } = await supabase
      .from('athlete_notes')
      .insert([{ athlete_id: parseInt(athleteId), date, note }])

    if (error) { console.log(error); customAlert('Something went wrong'); return }

    root.querySelector('#addNoteModal').classList.remove('active')
    loadLatestNote()
  })

  root.querySelector('#viewNotesBtn').addEventListener('click', function() {
    root.querySelector('#notesListModal').classList.add('active')
    loadNotesList()
  })

  root.querySelector('#closeNotesListBtn').addEventListener('click', function() {
    root.querySelector('#notesListModal').classList.remove('active')
  })

  root.querySelector('#cancelEditNoteBtn').addEventListener('click', function() {
    root.querySelector('#editNoteModal').classList.remove('active')
  })

  root.querySelector('#saveEditNoteBtn').addEventListener('click', async function() {
    const date = root.querySelector('#editNoteDate').value
    const note = root.querySelector('#editNoteText').value.trim()

    if (!date || !note) { customAlert('Please fill in date and note'); return }

    const { error } = await supabase
      .from('athlete_notes')
      .update({ date, note })
      .eq('id', currentNoteEntry.id)

    if (error) { customAlert('Something went wrong'); return }

    root.querySelector('#editNoteModal').classList.remove('active')
    loadNotesList()
    loadLatestNote()
  })
}

// ==========================================================================
// ---- UNIT CONVERSION HELPERS ----
// Converts stored values (always in a base unit, e.g. cm) into whatever
// display unit the user has chosen (in / ft), and back again for saving.
// ==========================================================================
function convertValue(value, displayUnit) {
  if (!displayUnit || !value) return { text: value, unit: displayUnit || '' }

  if (displayUnit === 'in') {
    const inches = (value / 2.54).toFixed(1)
    return { text: inches, unit: 'in' }
  }

  if (displayUnit === 'ft') {
    const totalInches = value / 2.54
    const feet = Math.floor(totalInches / 12)
    const inches = Math.round(totalInches % 12)
    return { text: `${feet}'${inches}"`, unit: '' }
  }

  return { text: value, unit: displayUnit }
}

function convertInput(value, displayUnit) {
  if (!displayUnit || !value) return value
  if (displayUnit === 'in') return +(value * 2.54).toFixed(1)
  if (displayUnit === 'ft') return +(value * 30.48).toFixed(1)
  return value
}

// ==========================================================================
// ---- LOAD ALL AVAILABLE METRICS ----
// Loads the full catalog of metric types (e.g. "Vertical Jump", "Zone 2 Run")
// from the DB and populates the "add metric" dropdown with them.
// ==========================================================================
async function loadAllMetrics() {
  const token = mountToken
  const { data, error } = await window.fetchWithRetry((signal) => supabase
    .from('metrics')
    .select('*')
    .abortSignal(signal)
  )

  if (!nav.isCurrent(token)) return

  if (error) {
    console.log('Error loading metrics:', error)
    customAlert('Something went wrong loading metrics - check your connection and try again')
    return
  }

  allMetrics = data

  // Fill the metric dropdown
  const select = root.querySelector('#metricSelect')
  data.forEach(metric => {
    const option = document.createElement('option')
    option.value = metric.id
    option.textContent = `${metric.name} (${metric.unit})`
    select.appendChild(option)
  })
}

// ==========================================================================
// ---- LOAD ATHLETE'S ASSIGNED METRICS ----
// Loads only the metrics this specific athlete is being tracked on, joins in
// the metric definition (name/unit/type) from allMetrics, then renders them.
// ==========================================================================
async function loadAthleteMetrics() {
  const token = mountToken
  const { data, error } = await window.fetchWithRetry((signal) => supabase
    .from('athlete_metrics')
    .select('*')
    .eq('athlete_id', athleteId)
    .abortSignal(signal)
  )

  if (!nav.isCurrent(token)) return

  if (error) {
    console.log('Error loading athlete metrics:', error)
    customAlert('Something went wrong loading tracked metrics - check your connection and try again')
    return
  }

  // Add metric details to each athlete_metric
  athleteMetrics = data.map(am => {
    return {
      ...am,
      metrics: allMetrics.find(m => m.id === am.metric_id)
    }
  })
  await renderMetrics()
  if (!nav.isCurrent(token)) return
  loadStatsBar()
}

// ==========================================================================
// ---- RENDER METRICS ON SCREEN ----
// The big one: builds the metrics grid, grouped by category. For each
// metric it loads recent measurements, works out the "latest value" text,
// computes a % change badge, draws the mini graph, and wires up all the
// buttons (record / delete / open details) for that card.
// ==========================================================================
async function renderMetrics() {
  const token = mountToken
  const list = root.querySelector('#metricsList')
  list.innerHTML = ''

  if (athleteMetrics.length === 0) {
    list.innerHTML = '<p class="no-metrics">No metrics added yet — click "+ Add Metric" to start tracking!</p>'
    return
  }

  // Every tracked metric's last 3 months of measurements, fetched in ONE
  // query instead of one query per metric (and reused below for the
  // mini-graphs too, instead of fetching the exact same data a second
  // time) - this used to be up to 2-3 sequential database round-trips per
  // tracked metric, which made this tab noticeably slow to open with more
  // than a few metrics tracked.
  const metricIds = athleteMetrics.map(am => am.metrics.id)
  const threeMonthsAgo = new Date()
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3)
  const fromDate = threeMonthsAgo.toISOString().split('T')[0]

  const { data: recentMeasurements } = await window.fetchWithRetry((signal) => supabase
    .from('measurements')
    .select('*')
    .eq('athlete_id', athleteId)
    .in('metric_id', metricIds)
    .gte('date', fromDate)
    .order('date', { ascending: true })
    .abortSignal(signal)
  )

  if (!nav.isCurrent(token)) return

  const measurementsByMetric = {}
  for (const m of recentMeasurements || []) {
    if (!measurementsByMetric[m.metric_id]) measurementsByMetric[m.metric_id] = []
    measurementsByMetric[m.metric_id].push(m)
  }

  // Zone2 metrics need their FULL history (not just 3 months) for the
  // 30-vs-60-day comparison below - same one-query-for-everyone approach,
  // and only run at all if there's actually a Zone2 metric tracked
  const zone2MetricIds = athleteMetrics.filter(am => am.metrics.type === 'zone2').map(am => am.metrics.id)
  const zone2AllByMetric = {}
  if (zone2MetricIds.length > 0) {
    const { data: allZone2Measurements } = await window.fetchWithRetry((signal) => supabase
      .from('measurements')
      .select('*')
      .eq('athlete_id', athleteId)
      .in('metric_id', zone2MetricIds)
      .order('date', { ascending: false })
      .abortSignal(signal)
    )

    if (!nav.isCurrent(token)) return

    for (const m of allZone2Measurements || []) {
      if (!zone2AllByMetric[m.metric_id]) zone2AllByMetric[m.metric_id] = []
      zone2AllByMetric[m.metric_id].push(m)
    }
  }

  // Group metrics by category
  const categories = {}
  for (const am of athleteMetrics) {
    const category = am.metrics?.category || 'Other'
    if (!categories[category]) categories[category] = []
    categories[category].push(am)
  }

  // Render each category
  for (const [category, items] of Object.entries(categories)) {
    const categorySection = document.createElement('div')
    categorySection.classList.add('metric-category')
    categorySection.innerHTML = `<h4 class="category-title">${category}</h4>`

    const grid = document.createElement('div')
    grid.classList.add('metrics-grid')

    for (const am of items) {
      const metric = am.metrics
      const measurements = measurementsByMetric[metric.id] || []

      const item = document.createElement('div')
      item.classList.add('metric-item')
      item.dataset.metricId = metric.id

     const latest = measurements.length > 0 ? measurements[measurements.length - 1] : null
      let latestText = 'No measurements yet'
      let changeHTML = ''

      if (latest) {
        // --- Build the "Latest: ..." text, differently per metric type ---
        if (metric.type === 'pogo') {
          const converted = convertValue(latest.height, metric.display_unit)
          latestText = `Height: ${converted.text}${converted.unit} · GCT: ${latest.ground_contact}ms · RSI: ${latest.rsi}`
        } else if (metric.type === 'zone2') {
          latestText = `Score: ${latest.value}`
        } else {
          const converted = convertValue(latest.value, metric.display_unit)
          latestText = `${converted.text} ${converted.unit}`
        }

        // --- Calculate % change badge (▲/▼ x%) shown next to the metric name ---
        if (metric.type === 'zone2') {
          // Zone2: compare average score of last 30 days vs the 30 days before that
          const allZone2 = zone2AllByMetric[metric.id] || []

          if (allZone2.length >= 2) {
            const now = new Date()
            const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
            const sixtyDaysAgo = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

            const last30 = allZone2.filter(m => m.date >= thirtyDaysAgo)
            const prev30 = allZone2.filter(m => m.date >= sixtyDaysAgo && m.date < thirtyDaysAgo)

            if (last30.length > 0 && prev30.length > 0) {
              const avg30 = last30.reduce((sum, m) => sum + m.value, 0) / last30.length
              const avgPrev = prev30.reduce((sum, m) => sum + m.value, 0) / prev30.length
              const pct = +(((avg30 - avgPrev) / avgPrev) * 100).toFixed(1)
              const isPositive = metric.higher_is_better ? pct > 0 : pct < 0
              const cssClass = pct === 0 ? 'neutral' : isPositive ? 'positive' : 'negative'
              const arrow = pct > 0 ? '▲' : '▼'
changeHTML = `<span class="metric-change ${cssClass}" style="cursor:pointer" data-explain-type="zone2" data-metric-type="${metric.type}" data-metric-name="${metric.name}" data-avg30="${avg30.toFixed(3)}" data-avgprev="${avgPrev.toFixed(3)}" data-pct="${pct}" data-higher="${metric.higher_is_better}">${arrow} ${Math.abs(pct)}%</span>`            }
          }
        } else {
          // All other metric types: compare latest value vs avg of previous 5 entries
          const getValue = m => metric.type === 'pogo' ? m.rsi : m.value
          const latestVal = getValue(latest)

          if (measurements.length >= 2) {
            const previous = measurements.slice(0, -1).slice(-5)
            const avgPrev = previous.reduce((sum, m) => sum + getValue(m), 0) / previous.length
            const pct = +(((latestVal - avgPrev) / avgPrev) * 100).toFixed(1)
            const isPositive = metric.higher_is_better ? pct > 0 : pct < 0
            const cssClass = pct === 0 ? 'neutral' : isPositive ? 'positive' : 'negative'
            const arrow = pct > 0 ? '▲' : '▼'
changeHTML = `<span class="metric-change ${cssClass}" style="cursor:pointer" data-explain-type="simple" data-metric-type="${metric.type}" data-metric-name="${metric.name}" data-latest="${latestVal}" data-avgprev="${avgPrev.toFixed(3)}" data-pct="${pct}" data-higher="${metric.higher_is_better}" data-unit="${metric.display_unit || metric.unit}">${arrow} ${Math.abs(pct)}%</span>`          }
        }
      }

      // --- Build the card's HTML: header, latest value, mini-graph placeholder ---
      item.innerHTML = `
        <div class="metric-item-header">
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap">
            <h4>${metric.name}</h4>
            ${changeHTML}
          </div>
          <div style="display:flex; align-items:center; gap:8px">
            <button class="btn-record" data-metric-id="${metric.id}">+ Record</button>
            <button class="btn-delete-metric" data-athlete-metric-id="${am.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
          </div>
        </div>
        <p class="metric-latest">Latest: ${latestText}</p>
        <div class="metric-graph-area">
          ${measurements && measurements.length > 1 ? `
            <canvas id="mini-graph-${metric.id}"></canvas>
            <p class="graph-hint">Click to expand</p>
          ` : '<p style="color:#4a4a8e;font-size:12px">Add 2+ measurements to see graph</p>'}
        </div>
      `

      grid.appendChild(item)
    }

    categorySection.appendChild(grid)
    list.appendChild(categorySection)
  }

  // --- Wire up "+ Record" buttons: open the measurement modal for that metric ---
  root.querySelectorAll('.btn-record').forEach(btn => {
    btn.addEventListener('click', function() {
      const metricId = parseInt(this.dataset.metricId)
      currentMetric = allMetrics.find(m => m.id === metricId)
      openMeasurementModal()
    })
  })

  // --- Wire up "delete metric" buttons: unassign a metric from this athlete ---
  root.querySelectorAll('.btn-delete-metric').forEach(btn => {
    btn.addEventListener('click', async function() {
      const athleteMetricId = parseInt(this.dataset.athleteMetricId)
      if (!(await customConfirm('Remove this metric from the athlete?'))) return

      const { error } = await supabase
        .from('athlete_metrics')
        .delete()
        .eq('id', athleteMetricId)

      if (error) { console.log('Error deleting metric:', error); customAlert('Something went wrong'); return }

      loadAthleteMetrics()
    })
  })

  // --- Wire up "delete measurement" buttons (used elsewhere in the UI) ---
  root.querySelectorAll('.btn-delete-measurement').forEach(btn => {
    btn.addEventListener('click', async function() {
      const measurementId = parseInt(this.dataset.measurementId)
      if (!(await customConfirm('Delete this measurement?'))) return

      const { error } = await supabase
        .from('measurements')
        .delete()
        .eq('id', measurementId)

      if (error) { console.log('Error deleting measurement:', error); customAlert('Something went wrong'); return }

      loadAthleteMetrics()
    })
  })

  // --- Draw the small trend chart (Chart.js) inside each metric card ---
  // Reuses measurementsByMetric (fetched once, up top) instead of querying
  // the same 3-months-of-measurements data a second time per metric. Charts
  // created here are tracked in miniChartInstances so unmount() can destroy
  // them - see that array's own comment.
  const hasAnyGraph = athleteMetrics.some(am => (measurementsByMetric[am.metrics.id] || []).length >= 2)
  if (hasAnyGraph) {
    await loadChartJs()
    if (!nav.isCurrent(token)) return
  }

  for (const am of athleteMetrics) {
    const metric = am.metrics
    const canvas = root.querySelector(`#mini-graph-${metric.id}`)
    if (!canvas) continue

    const graphData = measurementsByMetric[metric.id] || []
    if (graphData.length < 2) continue

    const labels = graphData.map(m => m.date)
    const values = graphData.map(m => metric.type === 'pogo' ? m.rsi : m.value)

    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: '#4a4a8e',
          backgroundColor: 'rgba(74, 74, 142, 0.1)',
          borderWidth: 2,
          pointRadius: 3,
          tension: 0.3,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { display: false },
          y: { display: false }
        }
      }
    })
    miniChartInstances.push(chart)

    // Clicking the mini graph opens the full-size graph modal
    canvas.addEventListener('click', function() {
      openGraphModal(metric)
    })
  }

  // --- Clicking anywhere on a metric card (except buttons/canvas/change badge)
  //     opens the full entries list for that metric; clicking the % change
  //     badge instead opens the "explain this change" breakdown ---
  root.querySelectorAll('.metric-item').forEach(item => {
    item.addEventListener('click', function(e) {
      if (e.target.classList.contains('btn-record') ||
          e.target.classList.contains('btn-delete-metric') ||
          e.target.tagName === 'CANVAS') return

      if (e.target.classList.contains('metric-change')) {
        openChangeExplain(e.target)
        return
      }

      const metricId = parseInt(this.dataset.metricId)
      const metric = allMetrics.find(m => m.id === metricId)
      openEntriesModal(metric)
    })
  })
}

// ==========================================================================
// ---- OPEN MEASUREMENT MODAL ----
// Shows/hides the right input fields (simple value / pogo jump / zone2 run)
// depending on the metric type, then opens the "record measurement" modal.
// ==========================================================================
function openMeasurementModal() {
  root.querySelector('#measurementModalTitle').textContent =
    `Record — ${currentMetric.name}`

  // Set today's date as default
  root.querySelector('#measurementDate').valueAsDate = new Date()

  // Show right fields based on metric type
  if (currentMetric.type === 'pogo') {
    root.querySelector('#simpleFields').style.display = 'none'
    root.querySelector('#pogoFields').style.display = 'block'
    root.querySelector('#zone2Fields').style.display = 'none'
    const pogoUnit = currentMetric.display_unit || 'cm'
    root.querySelector('#pogoHeightLabel').textContent = `Height (${pogoUnit})`
  } else if (currentMetric.type === 'zone2') {
    root.querySelector('#simpleFields').style.display = 'none'
    root.querySelector('#pogoFields').style.display = 'none'
    root.querySelector('#zone2Fields').style.display = 'block'
  } else {
    root.querySelector('#simpleFields').style.display = 'block'
    root.querySelector('#pogoFields').style.display = 'none'
    root.querySelector('#zone2Fields').style.display = 'none'

    // Simple numeric metrics can display as a single value or as feet+inches
    if (currentMetric.display_unit === 'ft') {
      root.querySelector('#singleValueGroup').style.display = 'none'
      root.querySelector('#feetInchesGroup').style.display = 'block'
    } else {
      root.querySelector('#singleValueGroup').style.display = 'block'
      root.querySelector('#feetInchesGroup').style.display = 'none'
      root.querySelector('#valueLabel').textContent =
        `${currentMetric.name} (${currentMetric.display_unit || currentMetric.unit})`
    }
  }

  root.querySelector('#addMeasurementModal').classList.add('active')
}

async function onSaveMetric() {
  const metricId = parseInt(root.querySelector('#metricSelect').value)

  if (!metricId) {
    customAlert('Please select a metric')
    return
  }

  const { error } = await supabase
    .from('athlete_metrics')
    .insert([{
      athlete_id: parseInt(athleteId),
      metric_id: metricId
    }])

  if (error) {
    console.log('Error adding metric:', error)
    customAlert('Something went wrong')
    return
  }

  root.querySelector('#addMetricModal').classList.remove('active')
  loadAthleteMetrics()
}

async function onSaveMeasurement() {
  const date = root.querySelector('#measurementDate').value

  if (!date) {
    customAlert('Please select a date')
    return
  }

  let insertData = {
    athlete_id: parseInt(athleteId),
    metric_id: currentMetric.id,
    date: date,
    notes: root.querySelector('#measurementNotes').value
  }

  if (currentMetric.type === 'pogo') {
    insertData.height = convertInput(parseFloat(root.querySelector('#pogoHeight').value), currentMetric.display_unit)
    insertData.ground_contact = parseFloat(root.querySelector('#pogoGroundContact').value)
    insertData.rsi = parseFloat(root.querySelector('#pogoRSI').value)
  } else if (currentMetric.type === 'zone2') {
    // Zone2 "efficiency score" = 1000 / (pace × heart rate) — lower pace & bpm is better
    const paceMin = parseFloat(root.querySelector('#zone2PaceMin').value) || 0
    const paceSec = parseFloat(root.querySelector('#zone2PaceSec').value) || 0
    const pace = paceMin + (paceSec / 60)
    const bpm = parseFloat(root.querySelector('#zone2BPM').value)
    const distance = parseFloat(root.querySelector('#zone2Distance').value)
    const durMin = parseFloat(root.querySelector('#zone2DurMin').value) || 0
    const durSec = parseFloat(root.querySelector('#zone2DurSec').value) || 0
    const duration = durMin + (durSec / 60)
    const score = +(1000 / (pace * bpm)).toFixed(3)
    insertData.pace = pace
    insertData.bpm = bpm
    insertData.distance = distance
    insertData.duration = duration
    insertData.value = score
  } else {
    let rawValue
    if (currentMetric.display_unit === 'ft') {
      const feet = parseFloat(root.querySelector('#measurementFeet').value) || 0
      const inches = parseFloat(root.querySelector('#measurementInches').value) || 0
      rawValue = feet + (inches / 12)
    } else {
      rawValue = parseFloat(root.querySelector('#measurementValue').value)
    }
    insertData.value = convertInput(rawValue, currentMetric.display_unit)
  }

  const { error } = await supabase
    .from('measurements')
    .insert([insertData])

  if (error) {
    console.log('Error saving measurement:', error)
    customAlert('Something went wrong')
    return
  }

  root.querySelector('#addMeasurementModal').classList.remove('active')
  loadAthleteMetrics()
}

async function onCreateMetric() {
  const name = root.querySelector('#newMetricName').value.trim()
  const unit = root.querySelector('#newMetricUnit').value.trim()
  const type = root.querySelector('#newMetricType').value

  if (!name || !unit) {
    customAlert('Please fill in both name and unit')
    return
  }

  const category = root.querySelector('#newMetricCategory').value
  const { data, error } = await supabase
    .from('metrics')
    .insert([{ name, unit, type, category }])
    .select()

  if (error) {
    console.log('Error creating metric:', error)
    customAlert('Something went wrong')
    return
  }

  // Add new metric to allMetrics and dropdown
  allMetrics.push(data[0])
  const select = root.querySelector('#metricSelect')
  const option = document.createElement('option')
  option.value = data[0].id
  option.textContent = `${data[0].name} (${data[0].unit})`
  select.appendChild(option)
  select.value = data[0].id

  // Clear form
  root.querySelector('#newMetricName').value = ''
  root.querySelector('#newMetricUnit').value = ''

  // Go back to add metric modal
  root.querySelector('#createMetricModal').classList.remove('active')
  root.querySelector('#addMetricModal').classList.add('active')

  customAlert(`"${name}" created and selected!`)
}

function bindMetricsStaticEvents() {
  root.querySelector('#addMetricBtn').addEventListener('click', function() {
    root.querySelector('#addMetricModal').classList.add('active')
  })

  root.querySelector('#cancelMetricBtn').addEventListener('click', function() {
    root.querySelector('#addMetricModal').classList.remove('active')
  })

  root.querySelector('#saveMetricBtn').addEventListener('click', onSaveMetric)

  root.querySelector('#cancelMeasurementBtn').addEventListener('click', function() {
    root.querySelector('#addMeasurementModal').classList.remove('active')
  })

  root.querySelector('#saveMeasurementBtn').addEventListener('click', onSaveMeasurement)

  root.querySelector('#createNewMetricBtn').addEventListener('click', function() {
    root.querySelector('#addMetricModal').classList.remove('active')
    root.querySelector('#createMetricModal').classList.add('active')
  })

  root.querySelector('#cancelCreateMetricBtn').addEventListener('click', function() {
    root.querySelector('#createMetricModal').classList.remove('active')
    root.querySelector('#addMetricModal').classList.add('active')
  })

  root.querySelector('#saveNewMetricBtn').addEventListener('click', onCreateMetric)

  root.querySelector('#closeEntriesBtn').addEventListener('click', function() {
    root.querySelector('#entriesModal').classList.remove('active')
  })

  root.querySelector('#cancelEditEntryBtn').addEventListener('click', function() {
    root.querySelector('#editEntryModal').classList.remove('active')
  })

  root.querySelector('#saveEditEntryBtn').addEventListener('click', onSaveEditEntry)

  // ---- Stats bar detail modals (PR / Metrics Tracked / Total Entries / Last Updated) ----
  root.querySelector('#statPRsCard').addEventListener('click', function() {
    root.querySelector('#prModal').classList.add('active')
    renderPRModal()
  })
  root.querySelector('#closePRModalBtn').addEventListener('click', function() {
    root.querySelector('#prModal').classList.remove('active')
  })

  root.querySelector('#statMetricsCard').addEventListener('click', function() {
    root.querySelector('#metricsTrackedModal').classList.add('active')
    renderMetricsTrackedModal()
  })
  root.querySelector('#closeMetricsTrackedModalBtn').addEventListener('click', function() {
    root.querySelector('#metricsTrackedModal').classList.remove('active')
  })

  root.querySelector('#statEntriesCard').addEventListener('click', function() {
    root.querySelector('#totalEntriesModal').classList.add('active')
    renderTotalEntriesModal()
  })
  root.querySelector('#closeTotalEntriesModalBtn').addEventListener('click', function() {
    root.querySelector('#totalEntriesModal').classList.remove('active')
  })

  root.querySelector('#statLastUpdatedCard').addEventListener('click', function() {
    root.querySelector('#lastUpdatedModal').classList.add('active')
    recentActivityPage = 0 // always start back at the newest entries when reopening
    renderLastUpdatedModal()
  })
  root.querySelector('#closeLastUpdatedModalBtn').addEventListener('click', function() {
    root.querySelector('#lastUpdatedModal').classList.remove('active')
  })
}

// ==========================================================================
// ---- STATS BAR ----
// Fills in the top summary row: total entries logged, number of metrics
// tracked, how recently the athlete last logged something, and how many
// personal records (PRs) were set this month.
// ==========================================================================
async function loadStatsBar() {
  const token = mountToken
  // Get all measurements for this athlete
  const { data: allMeasurements, error } = await window.fetchWithRetry((signal) => supabase
    .from('measurements')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: false })
    .abortSignal(signal)
  )

  if (!nav.isCurrent(token)) return
  if (error) { console.log('Error loading stats bar:', error) }
  if (!allMeasurements) return

  allMeasurementsCache = allMeasurements // so the stats-bar detail modals can reuse this without re-querying

  // Total entries
  root.querySelector('#statEntries').textContent = allMeasurements.length

  // Metrics tracked
  root.querySelector('#statMetrics').textContent = athleteMetrics.length

  // Last updated
  if (allMeasurements.length > 0) {
    const lastDate = new Date(allMeasurements[0].date)
    const today = new Date()
    const diffDays = Math.floor((today - lastDate) / (1000 * 60 * 60 * 24))
    if (diffDays === 0) {
      root.querySelector('#statLastUpdated').textContent = 'Today'
    } else if (diffDays === 1) {
      root.querySelector('#statLastUpdated').textContent = 'Yesterday'
    } else {
      root.querySelector('#statLastUpdated').textContent = `${diffDays}d ago`
    }
  }

  // PRs in the last 30 days: walk each metric's measurements oldest-to-newest,
  // tracking the running best value. Any entry that beats the running best
  // counts as a PR - except the very first entry ever logged for a metric,
  // since it has no earlier value to compare against and can't be a "record".
  const now = new Date()
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  let prCount = 0
  prEvents = [] // reset the module-level list the PR overview modal reads from

  for (const am of athleteMetrics) {
    const metric = am.metrics
    if (!metric) continue

    // Get all measurements for this metric, oldest first, so we can track the running best
    const metricMeasurements = allMeasurements
      .filter(m => m.metric_id === metric.id)
      .sort((a, b) => a.date.localeCompare(b.date))

    if (metricMeasurements.length < 2) continue // need a baseline entry + at least one challenger

    const getValue = m => metric.type === 'pogo' ? m.rsi : m.value
    const higherIsBetter = metric.higher_is_better

    // First entry is just the baseline - it can never be a PR itself
    let best = getValue(metricMeasurements[0])

    for (let i = 1; i < metricMeasurements.length; i++) {
      const entry = metricMeasurements[i]
      const value = getValue(entry)
      const isNewBest = higherIsBetter ? value > best : value < best

      if (isNewBest) {
        if (entry.date >= thirtyDaysAgo) {
          prCount++
          // Keep the metric + entry so the PR overview modal can display and group it
          prEvents.push({ metric, entry })
        }
        best = value
      }
    }
  }

  root.querySelector('#statPRs').textContent = prCount
}

// ==========================================================================
// ---- PR OVERVIEW MODAL ----
// Opened by clicking the "PRs (last 30 days)" stat tile. Shows prEvents
// (filled in by loadStatsBar above) grouped by category, then by individual
// metric, with each metric's PRs listed chronologically (oldest first) so
// repeat PRs on the same metric read as a clear progression.
// ==========================================================================

// Same value-formatting rules used by the "All Entries" table, per metric type
function formatMeasurementValue(metric, entry) {
  if (metric.type === 'pogo') {
    const converted = convertValue(entry.height, metric.display_unit)
    return `RSI ${entry.rsi} (H: ${converted.text}${converted.unit}, GCT: ${entry.ground_contact}ms)`
  } else if (metric.type === 'zone2') {
    return `Score: ${entry.value}`
  } else {
    const converted = convertValue(entry.value, metric.display_unit)
    return `${converted.text} ${converted.unit}`
  }
}

// Shared category order for all "grouped by category" detail modals -
// known categories first in this fixed order, anything unrecognized
// falls back to the end, alphabetically
function sortCategories(categoryNames) {
  const categoryOrder = ['Jumps', 'Sprints', 'Strength', 'Cardio']
  return categoryNames.sort((a, b) => {
    const ai = categoryOrder.indexOf(a)
    const bi = categoryOrder.indexOf(b)
    if (ai === -1 && bi === -1) return a.localeCompare(b)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
}

function renderPRModal() {
  const container = root.querySelector('#prList')

  if (prEvents.length === 0) {
    container.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No PRs broken in the last 30 days</p>'
    return
  }

  // Group PR events: category -> metric name -> array of {metric, entry}
  const byCategory = {}
  for (const ev of prEvents) {
    const category = ev.metric.category || 'Other'
    const metricName = ev.metric.name
    if (!byCategory[category]) byCategory[category] = {}
    if (!byCategory[category][metricName]) byCategory[category][metricName] = []
    byCategory[category][metricName].push(ev)
  }

  const categories = sortCategories(Object.keys(byCategory))

  container.innerHTML = categories.map(category => `
    <div class="detail-category">
      <h3 class="category-title">${category}</h3>
      ${Object.keys(byCategory[category]).sort().map(metricName => {
        // Chronological (oldest first) so multiple PRs on the same metric show progression
        const events = byCategory[category][metricName].sort((a, b) => a.entry.date.localeCompare(b.entry.date))
        return `
          <div class="detail-group">
            <h4 class="detail-group-title">${metricName}</h4>
            <ul class="detail-list">
              ${events.map(ev => `
                <li class="detail-row">
                  <span>${ev.entry.date}</span>
                  <span class="detail-row-value">${formatMeasurementValue(ev.metric, ev.entry)}</span>
                </li>
              `).join('')}
            </ul>
          </div>
        `
      }).join('')}
    </div>
  `).join('')
}

// ==========================================================================
// ---- METRICS TRACKED MODAL ----
// Opened by clicking the "Metrics tracked" stat tile. Lists every metric
// currently assigned to this athlete, grouped by category.
// ==========================================================================
function renderMetricsTrackedModal() {
  const container = root.querySelector('#metricsTrackedList')

  if (athleteMetrics.length === 0) {
    container.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No metrics tracked yet</p>'
    return
  }

  // Group tracked metrics by category
  const byCategory = {}
  for (const am of athleteMetrics) {
    const metric = am.metrics
    if (!metric) continue
    const category = metric.category || 'Other'
    if (!byCategory[category]) byCategory[category] = []
    byCategory[category].push(metric)
  }

  const categoryTypeLabels = { simple: 'Simple', pogo: 'Pogo', zone2: 'Zone 2' }
  const categories = sortCategories(Object.keys(byCategory))

  container.innerHTML = categories.map(category => `
    <div class="detail-category">
      <h3 class="category-title">${category}</h3>
      <ul class="detail-list">
        ${byCategory[category].sort((a, b) => a.name.localeCompare(b.name)).map(metric => `
          <li class="detail-row">
            <span>${metric.name}</span>
            <span class="detail-row-value">${categoryTypeLabels[metric.type] || metric.type}</span>
          </li>
        `).join('')}
      </ul>
    </div>
  `).join('')
}

// ==========================================================================
// ---- TOTAL ENTRIES MODAL ----
// Opened by clicking the "Total entries" stat tile. Shows how many
// measurements are logged per metric, grouped by category.
// ==========================================================================
function renderTotalEntriesModal() {
  const container = root.querySelector('#totalEntriesList')

  if (allMeasurementsCache.length === 0) {
    container.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No entries logged yet</p>'
    return
  }

  // Count entries per metric, grouped by category (skip metrics with 0 entries)
  const byCategory = {}
  for (const am of athleteMetrics) {
    const metric = am.metrics
    if (!metric) continue
    const count = allMeasurementsCache.filter(m => m.metric_id === metric.id).length
    if (count === 0) continue
    const category = metric.category || 'Other'
    if (!byCategory[category]) byCategory[category] = []
    byCategory[category].push({ metric, count })
  }

  const categories = sortCategories(Object.keys(byCategory))

  container.innerHTML = categories.map(category => `
    <div class="detail-category">
      <h3 class="category-title">${category}</h3>
      <ul class="detail-list">
        ${byCategory[category].sort((a, b) => a.metric.name.localeCompare(b.metric.name)).map(({ metric, count }) => `
          <li class="detail-row">
            <span>${metric.name}</span>
            <span class="detail-row-value">${count} ${count === 1 ? 'entry' : 'entries'}</span>
          </li>
        `).join('')}
      </ul>
    </div>
  `).join('')
}

// ==========================================================================
// ---- LAST UPDATED / RECENT ACTIVITY MODAL ----
// Opened by clicking the "Last updated" stat tile. Reverse-chronological
// feed of every entry logged, newest first, across all metrics.
// ==========================================================================

// How many entries per page (21-40, 41-60, etc), and which page we're currently on
const RECENT_ACTIVITY_PAGE_SIZE = 20

function renderLastUpdatedModal() {
  const container = root.querySelector('#lastUpdatedList')

  if (allMeasurementsCache.length === 0) {
    container.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No entries logged yet</p>'
    return
  }

  // Map metric_id -> metric so each measurement can show its metric's name and formatted value
  const metricById = {}
  for (const am of athleteMetrics) {
    if (am.metrics) metricById[am.metrics.id] = am.metrics
  }

  const sorted = [...allMeasurementsCache].sort((a, b) => b.date.localeCompare(a.date))

  const start = recentActivityPage * RECENT_ACTIVITY_PAGE_SIZE
  const end = start + RECENT_ACTIVITY_PAGE_SIZE
  const pageEntries = sorted.slice(start, end)
  const hasPrev = recentActivityPage > 0
  const hasNext = end < sorted.length

  // Group same-day entries together under one date heading, so the date
  // isn't repeated on every row and same-day entries are easy to see as a batch
  const byDate = {}
  const dateOrder = []
  for (const m of pageEntries) {
    if (!byDate[m.date]) { byDate[m.date] = []; dateOrder.push(m.date) }
    byDate[m.date].push(m)
  }

  container.innerHTML = `
    ${dateOrder.map(date => `
      <div class="detail-group">
        <h4 class="detail-group-title">${formatDisplayDate(date)}</h4>
        <ul class="detail-list">
          ${byDate[date].map(m => {
            const metric = metricById[m.metric_id]
            if (!metric) return ''
            return `
              <li class="detail-row">
                <span>${metric.name}</span>
                <span class="detail-row-value">${formatMeasurementValue(metric, m)}</span>
              </li>
            `
          }).join('')}
        </ul>
      </div>
    `).join('')}
    <div class="pagination-row">
      ${hasPrev ? '<button class="pagination-btn" id="prevActivityBtn">← Previous</button>' : '<span></span>'}
      <span class="pagination-label">${start + 1}–${Math.min(end, sorted.length)} of ${sorted.length}</span>
      ${hasNext ? '<button class="pagination-btn" id="nextActivityBtn">Next →</button>' : '<span></span>'}
    </div>
  `

  if (hasPrev) {
    root.querySelector('#prevActivityBtn').addEventListener('click', function() {
      recentActivityPage--
      renderLastUpdatedModal()
    })
  }

  if (hasNext) {
    root.querySelector('#nextActivityBtn').addEventListener('click', function() {
      recentActivityPage++
      renderLastUpdatedModal()
    })
  }
}

// ==========================================================================
// ---- GRAPH MODAL ----
// Full-size Chart.js graph for one metric, with 1M/3M/1Y/All time filters.
// ==========================================================================

// ---- Auto-scaled averaging ----
// A fluctuating metric (day-to-day Zone 2 pace, say) is hard to read as a
// trend one raw entry at a time - each point below is instead the average
// of every entry in its week/2-week/month bucket, with the bucket size
// auto-scaled to the selected time range so a short window still shows
// enough points to be useful, and a long one doesn't stay just as jittery
// as the raw data. 1M is left as 'raw' (no averaging) since a month rarely
// has enough entries for averaging to help rather than just erase them.
const GRANULARITY_FOR_MONTHS = { 1: 'raw', 3: 'weekly', 6: 'biweekly', 12: 'monthly', 0: 'monthly' }
const GRANULARITY_LABELS = { raw: '', weekly: 'Showing weekly averages', biweekly: 'Showing biweekly averages', monthly: 'Showing monthly averages' }

function averageOf(nums) {
  const valid = nums.filter(n => n != null && !Number.isNaN(n))
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null
}

// Buckets are aligned to a fixed reference Monday, not the query's own start
// date - so a bucket's boundaries stay the same regardless of which time
// filter is active, which is what lets the metric series and the bodyweight
// overlay series (aggregated separately, via the same function) land on
// exactly the same bucket dates and merge cleanly onto one x-axis.
function chartBucketKey(dateStr, granularity) {
  const d = parseDateStrOv(dateStr)
  if (granularity === 'monthly') {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
  }
  const dayMs = 86400000
  const weekLength = granularity === 'biweekly' ? 14 : 7
  const epochMonday = new Date('2024-01-01T00:00:00') // an arbitrary real Monday, just a fixed grid reference
  const bucketIndex = Math.floor(Math.round((d - epochMonday) / dayMs) / weekLength)
  return toDateStrOv(new Date(epochMonday.getTime() + bucketIndex * weekLength * dayMs))
}

// Averages every listed field across entries sharing a bucket, returning one
// synthetic entry per bucket dated to the bucket's start. 'raw' is a no-op -
// callers pass every field formatMeasurementValue()/getValue() might read
// for the current metric type, so an aggregated point still has everything
// its tooltip needs (e.g. pogo's height/ground_contact alongside rsi).
function aggregateEntriesForChart(entries, granularity, valueFields) {
  if (granularity === 'raw' || entries.length === 0) return entries
  const buckets = new Map()
  for (const e of entries) {
    const key = chartBucketKey(e.date, granularity)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(e)
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, group]) => {
      const out = { date: key }
      for (const field of valueFields) out[field] = averageOf(group.map(e => e[field]))
      return out
    })
}

async function openGraphModal(metric) {
  currentGraphMetric = metric
  root.querySelector('#graphModalTitle').textContent = metric.name
  root.querySelector('#graphModal').classList.add('active')

  // Set 1M as default active filter
  root.querySelectorAll('.time-filter-btn[data-months]').forEach(btn => btn.classList.remove('active'))
  root.querySelector('.time-filter-btn[data-months="1"]').classList.add('active')

  // Bodyweight overlay always starts off when opening a graph, so it's
  // never confusingly left on for a metric you didn't turn it on for
  showBodyweightOverlay = false
  root.querySelector('#bodyweightOverlayToggle').checked = false

  await loadGraphData(1)
}

// Fetches measurements for the selected time range and (re)draws the chart
async function loadGraphData(months) {
  const token = mountToken
  currentGraphMonths = months

  let query = supabase
    .from('measurements')
    .select('*')
    .eq('athlete_id', athleteId)
    .eq('metric_id', currentGraphMetric.id)
    .order('date', { ascending: true })

  if (months > 0) {
    const fromDate = new Date()
    fromDate.setMonth(fromDate.getMonth() - months)
    query = query.gte('date', fromDate.toISOString().split('T')[0])
  }

  const { data } = await query
  if (!nav.isCurrent(token)) return

  // For Zone 2 metrics, show total km run within the selected time filter above the graph
  const periodStatEl = root.querySelector('#graphPeriodStat')
  if (currentGraphMetric.type === 'zone2') {
    const periodLabels = { 1: 'last month', 3: 'last 3 months', 6: 'last 6 months', 12: 'last year', 0: 'all time' }
    const totalKm = data ? data.reduce((sum, m) => sum + (m.distance || 0), 0).toFixed(1) : '0.0'
    periodStatEl.textContent = `${totalKm} km run · ${periodLabels[months]}`
  } else {
    periodStatEl.textContent = ''
  }

  // % change badge next to the title, recalculated for whichever time range
  // is currently selected: compares the average of the selected period
  // (e.g. the last 6 months, already loaded as `data` above) to the average
  // of the same-length period immediately before it (the 6 months before
  // that). "All" has no equivalent "previous" period to compare against, so
  // it falls back to splitting all-time data into an earlier half vs a
  // recent half instead.
  const changeStatEl = root.querySelector('#graphChangeStat')
  const periodBadgeLabels = { 1: '1M', 3: '3M', 6: '6M', 12: '1Y', 0: 'All' }
  const getValue = m => currentGraphMetric.type === 'pogo' ? m.rsi : m.value

  let currentPeriodData = data
  let previousPeriodData = null

  if (months > 0) {
    const currentStart = new Date()
    currentStart.setMonth(currentStart.getMonth() - months)
    const previousStart = new Date()
    previousStart.setMonth(previousStart.getMonth() - months * 2)

    const { data: prevData } = await supabase
      .from('measurements')
      .select('*')
      .eq('athlete_id', athleteId)
      .eq('metric_id', currentGraphMetric.id)
      .gte('date', previousStart.toISOString().split('T')[0])
      .lt('date', currentStart.toISOString().split('T')[0])

    if (!nav.isCurrent(token)) return
    previousPeriodData = prevData
  } else if (data && data.length >= 2) {
    const half = Math.floor(data.length / 2)
    previousPeriodData = data.slice(0, half)
    currentPeriodData = data.slice(half)
  }

  if (!currentPeriodData || currentPeriodData.length === 0 || !previousPeriodData || previousPeriodData.length === 0) {
    changeStatEl.innerHTML = ''
  } else {
    const currentAvg = currentPeriodData.reduce((sum, m) => sum + getValue(m), 0) / currentPeriodData.length
    const previousAvg = previousPeriodData.reduce((sum, m) => sum + getValue(m), 0) / previousPeriodData.length
    const pct = +(((currentAvg - previousAvg) / previousAvg) * 100).toFixed(1)
    const higherIsBetter = currentGraphMetric.higher_is_better
    const isPositive = higherIsBetter ? pct > 0 : pct < 0
    const cssClass = pct === 0 ? 'neutral' : isPositive ? 'positive' : 'negative'
    const arrow = pct > 0 ? '▲' : '▼'

    changeStatEl.innerHTML = `<span class="metric-change ${cssClass}" style="cursor:pointer" data-explain-type="period" data-metric-type="${currentGraphMetric.type}" data-metric-name="${currentGraphMetric.name}" data-period-label="${periodBadgeLabels[months]}" data-first-avg="${previousAvg.toFixed(3)}" data-second-avg="${currentAvg.toFixed(3)}" data-pct="${pct}" data-higher="${higherIsBetter}" data-unit="${currentGraphMetric.display_unit || currentGraphMetric.unit}">${arrow} ${Math.abs(pct)}%</span>`

    const badge = changeStatEl.querySelector('.metric-change')
    badge.addEventListener('click', function() { openChangeExplain(badge) })
  }

  if (!data || data.length === 0) {
    if (fullChart) { fullChart.destroy(); fullChart = null }
    root.querySelector('#graphGranularityNote').textContent = ''
    return
  }

  const granularity = GRANULARITY_FOR_MONTHS[months]
  root.querySelector('#graphGranularityNote').textContent = GRANULARITY_LABELS[granularity]
  // Every field either render function's tooltip might read for this
  // metric's type - see formatMeasurementValue()/getValue() - so an
  // averaged bucket still has everything it needs to display correctly
  const chartData = aggregateEntriesForChart(data, granularity, ['value', 'rsi', 'height', 'ground_contact'])

  // Chart.js sizes its canvas from rendered pixel dimensions, so the graph
  // modal is already open (display isn't none) by the time this loads -
  // see this file's top banner comment for the full lazy-load rationale.
  await loadChartJs()
  if (!nav.isCurrent(token)) return

  if (showBodyweightOverlay) {
    await renderGraphWithBodyweightOverlay(chartData, months, granularity)
  } else {
    renderGraphRaw(chartData)
  }
}

// Shared dark-theme tooltip styling for both graph render functions below.
// `extra` can add/override fields (e.g. custom callbacks.label).
function themedTooltipOptions(extra) {
  return Object.assign({
    backgroundColor: '#1a1a2e',
    titleColor: '#ffffff',
    bodyColor: '#ffffff',
    borderColor: '#2a2a4e',
    borderWidth: 1,
    padding: 10,
    displayColors: true
  }, extra)
}

// Default view: this metric's own values in their own unit (cm, score, RSI, etc)
function renderGraphRaw(data) {
  const labels = data.map(m => m.date)
  const values = data.map(m => currentGraphMetric.type === 'pogo' ? m.rsi : m.value)

  if (fullChart) fullChart.destroy()

  const ctx = root.querySelector('#fullGraph').getContext('2d')
  fullChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: currentGraphMetric.name,
        data: values,
        borderColor: '#4a4a8e',
        backgroundColor: 'rgba(74, 74, 142, 0.12)',
        borderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: '#4a4a8e',
        tension: 0.35,
        cubicInterpolationMode: 'monotone',
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: themedTooltipOptions()
      },
      scales: {
        x: {
          ticks: { color: '#aaaacc' },
          grid: { color: '#2a2a4e' }
        },
        y: {
          ticks: { color: '#aaaacc' },
          grid: { color: '#2a2a4e' }
        }
      }
    }
  })
}

// Bodyweight overlay view: the metric (cm, score, RSI...) and bodyweight
// (kg) are completely different scales, so plotting both in their raw units
// on one axis - or bolting on a second y-axis - would be misleading. Instead
// both are indexed to "% change from the first value in this time range",
// which puts them on one shared, honest axis. The hover tooltip still shows
// each line's real value (metric in its own unit, bodyweight in kg/lbs), so
// the % is just how they're drawn, not how they're read.
async function renderGraphWithBodyweightOverlay(data, months, granularity) {
  const token = mountToken
  let bwQuery = supabase
    .from('bodyweight')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: true })

  let fromDateStr = null
  if (months > 0) {
    const fromDate = new Date()
    fromDate.setMonth(fromDate.getMonth() - months)
    fromDateStr = fromDate.toISOString().split('T')[0]
    bwQuery = bwQuery.gte('date', fromDateStr)
  }

  const { data: bwDataRaw } = await bwQuery
  if (!nav.isCurrent(token)) return
  // Aggregated with the exact same bucketing as the metric series (both go
  // through chartBucketKey with the same granularity), so the two series'
  // bucket dates line up and merge cleanly below instead of drifting apart
  const bwData = aggregateEntriesForChart(bwDataRaw || [], granularity, ['weight'])

  // Also grab the last bodyweight entry logged BEFORE this window, so if
  // nothing was logged during the selected range the line still carries
  // forward the athlete's last known weight instead of just disappearing
  let carryInWeight = null
  if (fromDateStr) {
    const { data: priorData } = await supabase
      .from('bodyweight')
      .select('weight')
      .eq('athlete_id', athleteId)
      .lt('date', fromDateStr)
      .order('date', { ascending: false })
      .limit(1)
    if (!nav.isCurrent(token)) return
    if (priorData && priorData.length > 0) carryInWeight = priorData[0].weight
  }

  const getMetricValue = m => currentGraphMetric.type === 'pogo' ? m.rsi : m.value

  // Combined, sorted list of every date either series has an entry on, so
  // both lines plot on the same x-axis even though their entries don't
  // line up 1-to-1 (metric-index gap and bodyweight-log dates rarely match)
  const allDates = [...new Set([...data.map(m => m.date), ...bwData.map(b => b.date)])].sort()

  // --- Metric series: indexed to % change from the first value shown ---
  const metricBaseline = getMetricValue(data[0])
  const metricByEntry = {}
  data.forEach(m => { metricByEntry[m.date] = m })
  const metricSeries = allDates.map(d => {
    const entry = metricByEntry[d]
    return entry ? +(((getMetricValue(entry) - metricBaseline) / metricBaseline) * 100).toFixed(2) : null
  })

  // --- Bodyweight series: carry the last known weight forward across dates
  // with no new entry, so the line stays flat/continuous instead of gapping
  // out when nothing was logged during part (or all) of the selected range ---
  const bwByDate = {}
  bwData.forEach(b => { bwByDate[b.date] = b.weight })

  const bwBaseline = carryInWeight !== null ? carryInWeight : (bwData[0] ? bwData[0].weight : null)

  let lastKnownWeight = carryInWeight
  const bwRawByDate = {}
  allDates.forEach(d => {
    if (d in bwByDate) lastKnownWeight = bwByDate[d]
    bwRawByDate[d] = lastKnownWeight
  })
  const bwSeries = bwBaseline === null
    ? allDates.map(() => null)
    : allDates.map(d => bwRawByDate[d] === null ? null : +(((bwRawByDate[d] - bwBaseline) / bwBaseline) * 100).toFixed(2))

  if (fullChart) fullChart.destroy()

  const ctx = root.querySelector('#fullGraph').getContext('2d')
  fullChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: allDates,
      datasets: [
        {
          label: currentGraphMetric.name,
          data: metricSeries,
          borderColor: '#4a4a8e',
          backgroundColor: 'rgba(74, 74, 142, 0.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#4a4a8e',
          tension: 0.35,
          cubicInterpolationMode: 'monotone',
          fill: false,
          spanGaps: true
        },
        {
          label: 'Bodyweight',
          data: bwSeries,
          borderColor: '#e0a458',
          backgroundColor: 'rgba(224, 164, 88, 0.08)',
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#e0a458',
          tension: 0.35,
          cubicInterpolationMode: 'monotone',
          fill: false,
          spanGaps: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, labels: { color: '#aaaacc' } },
        tooltip: themedTooltipOptions({
          callbacks: {
            // Show each line's real underlying value instead of the plotted
            // % - the % is only how the two share one axis visually
            label: function(context) {
              const date = context.label
              if (context.dataset.label === 'Bodyweight') {
                const raw = bwRawByDate[date]
                if (raw === null || raw === undefined) return 'Bodyweight: no data'
                const display = bodyweightUnit === 'lbs' ? (raw * 2.20462).toFixed(1) : raw.toFixed(1)
                return `Bodyweight: ${display} ${bodyweightUnit}`
              }
              const entry = metricByEntry[date]
              if (!entry) return `${currentGraphMetric.name}: no data`
              return `${currentGraphMetric.name}: ${formatMeasurementValue(currentGraphMetric, entry)}`
            }
          }
        })
      },
      scales: {
        x: {
          ticks: { color: '#aaaacc' },
          grid: { color: '#2a2a4e' }
        },
        y: {
          ticks: { color: '#aaaacc', callback: v => `${v}%` },
          grid: { color: '#2a2a4e' },
          title: { display: true, text: '% change from period start', color: '#aaaacc' }
        }
      }
    }
  })
}

// Note: the Graph Modal's and Report Builder modal's time-period buttons
// both use the exact same `.time-filter-btn[data-months]` selector (see
// athlete.html originally, now the shared TEMPLATE above) - this was already
// true on the single-page site, not introduced by this conversion. That
// means opening/switching the graph also flips the Report modal's own
// active-filter button state (they're just CSS classes on hidden markup, so
// this has no visible effect), and clicking a Report month button also fires
// this handler below, calling loadGraphData() against whatever
// currentGraphMetric is currently set (or throwing into the console if none
// is, e.g. before any graph has ever been opened this session). See the
// report for this - preserved as-is rather than silently re-scoped, since
// scoping it would be a behavior change, not a structural conversion.
function bindGraphModalEvents() {
  root.querySelector('#closeGraphBtn').addEventListener('click', function() {
    root.querySelector('#graphModal').classList.remove('active')
    if (fullChart) { fullChart.destroy(); fullChart = null }
  })

  root.querySelector('#bodyweightOverlayToggle').addEventListener('change', async function() {
    showBodyweightOverlay = this.checked
    await loadGraphData(currentGraphMonths)
  })

  // Switching the 1M/3M/1Y/All buttons re-loads the graph for that range
  root.querySelectorAll('.time-filter-btn[data-months]').forEach(btn => {
    btn.addEventListener('click', async function() {
      root.querySelectorAll('.time-filter-btn[data-months]').forEach(b => b.classList.remove('active'))
      this.classList.add('active')
      const months = parseInt(this.dataset.months)
      await loadGraphData(months)
    })
  })
}

// ==========================================================================
// ---- ENTRIES MODAL ----
// Full history table for one metric: lists every measurement, with edit
// and delete actions per row.
// ==========================================================================
async function openEntriesModal(metric) {
  currentEntriesMetric = metric
  root.querySelector('#entriesModalTitle').textContent = `${metric.name} — All Entries`
  root.querySelector('#entriesModal').classList.add('active')

  await loadEntries(metric)
}

// Fetches and renders the entries table for a given metric
async function loadEntries(metric) {
  const token = mountToken
  const { data, error } = await supabase
    .from('measurements')
    .select('*')
    .eq('athlete_id', athleteId)
    .eq('metric_id', metric.id)
    .order('date', { ascending: false })

  if (!nav.isCurrent(token)) return
  const list = root.querySelector('#entriesList')

  if (!data || data.length === 0) {
    list.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No entries yet</p>'
    return
  }

  list.innerHTML = `
    <table class="entries-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Value</th>
          <th>Notes</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${data.map(m => {
          let valueText = ''
        if (metric.type === 'pogo') {
            const converted = convertValue(m.height, metric.display_unit)
            valueText = `H: ${converted.text}${converted.unit} · GCT: ${m.ground_contact}ms · RSI: ${m.rsi}`
          } else if (metric.type === 'zone2') {
            valueText = `Score: ${m.value}`
          } else {
            const converted = convertValue(m.value, metric.display_unit)
            valueText = `${converted.text} ${converted.unit}`
          }
          return `<tr>
            <td>${m.date}</td>
            <td>${valueText}</td>
            <td>${m.notes || '—'}</td>
            <td>
              <button class="btn-edit-entry" data-entry-id="${m.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg></button>
              <button class="btn-delete-measurement" data-measurement-id="${m.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
            </td>
          </tr>`
        }).join('')}
      </tbody>
    </table>
  `

  // Delete listener
  list.querySelectorAll('.btn-delete-measurement').forEach(btn => {
    btn.addEventListener('click', async function() {
      const measurementId = parseInt(this.dataset.measurementId)
      if (!(await customConfirm('Delete this entry?'))) return

      const { error } = await supabase
        .from('measurements')
        .delete()
        .eq('id', measurementId)

      if (error) { customAlert('Something went wrong'); return }

      await loadEntries(metric)
      loadAthleteMetrics()
    })
  })

  // Edit listener
  list.querySelectorAll('.btn-edit-entry').forEach(btn => {
    btn.addEventListener('click', async function() {
      const entryId = parseInt(this.dataset.entryId)
      const entry = data.find(m => m.id === entryId)
      openEditEntryModal(entry, metric)
    })
  })
}

// Populates the "edit entry" modal fields based on the metric type, then opens it
function openEditEntryModal(entry, metric) {
  currentEditEntry = entry
  root.querySelector('#editEntryDate').value = entry.date
  root.querySelector('#editEntryNotes').value = entry.notes || ''

  if (metric.type === 'pogo') {
    root.querySelector('#editSimpleFields').style.display = 'none'
    root.querySelector('#editPogoFields').style.display = 'block'
    root.querySelector('#editZone2Fields').style.display = 'none'
    const converted = convertValue(entry.height, metric.display_unit)
    root.querySelector('#editPogoHeight').value = converted.text || ''
    root.querySelector('#editPogoGroundContact').value = entry.ground_contact || ''
    root.querySelector('#editPogoRSI').value = entry.rsi || ''
  } else if (metric.type === 'zone2') {
    root.querySelector('#editSimpleFields').style.display = 'none'
    root.querySelector('#editPogoFields').style.display = 'none'
    root.querySelector('#editZone2Fields').style.display = 'block'
    const paceMin = Math.floor(entry.pace || 0)
    const paceSec = Math.round(((entry.pace || 0) - paceMin) * 60)
    root.querySelector('#editZone2PaceMin').value = paceMin
    root.querySelector('#editZone2PaceSec').value = paceSec
    root.querySelector('#editZone2BPM').value = entry.bpm || ''
    root.querySelector('#editZone2Distance').value = entry.distance || ''
    const durMin = Math.floor(entry.duration || 0)
    const durSec = Math.round(((entry.duration || 0) - durMin) * 60)
    root.querySelector('#editZone2DurMin').value = durMin
    root.querySelector('#editZone2DurSec').value = durSec
  } else {
    root.querySelector('#editSimpleFields').style.display = 'block'
    root.querySelector('#editPogoFields').style.display = 'none'
    root.querySelector('#editZone2Fields').style.display = 'none'
    if (metric.display_unit === 'ft') {
      root.querySelector('#editSingleValueGroup').style.display = 'none'
      root.querySelector('#editFeetInchesGroup').style.display = 'block'
      const totalInches = (entry.value / 2.54)
      const feet = Math.floor(totalInches / 12)
      const inches = +(totalInches % 12).toFixed(1)
      root.querySelector('#editEntryFeet').value = feet
      root.querySelector('#editEntryInches').value = inches
    } else {
      root.querySelector('#editSingleValueGroup').style.display = 'block'
      root.querySelector('#editFeetInchesGroup').style.display = 'none'
      root.querySelector('#editValueLabel').textContent = `${metric.name} (${metric.display_unit || metric.unit})`
      const converted = convertValue(entry.value, metric.display_unit)
      root.querySelector('#editEntryValue').value = converted.text || ''
    }
  }

  root.querySelector('#editEntryModal').classList.add('active')
}

// Saves edits to an existing measurement, rebuilding the payload per metric type
async function onSaveEditEntry() {
  const date = root.querySelector('#editEntryDate').value
  if (!date) { customAlert('Please select a date'); return }

  let updateData = {
    date,
    notes: root.querySelector('#editEntryNotes').value
  }

  if (currentEntriesMetric.type === 'pogo') {
    updateData.height = convertInput(parseFloat(root.querySelector('#editPogoHeight').value), currentEntriesMetric.display_unit)
    updateData.ground_contact = parseFloat(root.querySelector('#editPogoGroundContact').value)
    updateData.rsi = parseFloat(root.querySelector('#editPogoRSI').value)
  } else if (currentEntriesMetric.type === 'zone2') {
    const paceMin = parseFloat(root.querySelector('#editZone2PaceMin').value) || 0
    const paceSec = parseFloat(root.querySelector('#editZone2PaceSec').value) || 0
    const pace = paceMin + (paceSec / 60)
    const bpm = parseFloat(root.querySelector('#editZone2BPM').value)
    const distance = parseFloat(root.querySelector('#editZone2Distance').value)
    const durMin = parseFloat(root.querySelector('#editZone2DurMin').value) || 0
    const durSec = parseFloat(root.querySelector('#editZone2DurSec').value) || 0
    const duration = durMin + (durSec / 60)
    updateData.pace = pace
    updateData.bpm = bpm
    updateData.distance = distance
    updateData.duration = duration
    updateData.value = +(1000 / (pace * bpm)).toFixed(3)
  } else {
    let rawValue
    if (currentEntriesMetric.display_unit === 'ft') {
      const feet = parseFloat(root.querySelector('#editEntryFeet').value) || 0
      const inches = parseFloat(root.querySelector('#editEntryInches').value) || 0
      rawValue = feet + (inches / 12)
    } else {
      rawValue = parseFloat(root.querySelector('#editEntryValue').value)
    }
    updateData.value = convertInput(rawValue, currentEntriesMetric.display_unit)
  }

  const { error } = await supabase
    .from('measurements')
    .update(updateData)
    .eq('id', currentEditEntry.id)

  if (error) { console.log(error); customAlert('Something went wrong'); return }

  root.querySelector('#editEntryModal').classList.remove('active')
  await loadEntries(currentEntriesMetric)
  loadAthleteMetrics()
}

// ==========================================================================
// ---- EDIT ATHLETE INFO ----
// Saves changes made in the "edit athlete" modal (name, DOB, gender, height,
// email). Weight is not edited here - see the Bodyweight feature for that.
// Email is what links this athlete row to their own login once they sign up
// in the athlete app (see claim_athlete_by_email in sql-history.sql).
// ==========================================================================
function bindEditAthleteEvents() {
  root.querySelector('#closeEditAthleteBtn').addEventListener('click', function() {
    root.querySelector('#editAthleteModal').classList.remove('active')
  })

  root.querySelector('#cancelEditAthleteBtn').addEventListener('click', function() {
    root.querySelector('#editAthleteModal').classList.remove('active')
  })

  root.querySelector('#saveEditAthleteBtn').addEventListener('click', async function() {
    const name = root.querySelector('#editAthleteName').value.trim()
    // Empty -> null, not '' - a blank string sent to a `date` column errors
    // outright, and an empty gender fails its check constraint, so clearing
    // either field back out (not just leaving it blank on first save) would
    // fail too. Height goes through the same treatment since parseInt('') is NaN.
    const dobRaw = root.querySelector('#editAthleteDOB').value
    const dob = dobRaw || null
    const genderRaw = root.querySelector('#editAthleteGender').value
    const gender = genderRaw || null
    const heightRaw = parseInt(root.querySelector('#editAthleteHeight').value)
    const height = Number.isNaN(heightRaw) ? null : heightRaw
    // Empty -> null, not '' - the email column has a "no duplicates" rule in
    // the database, and two blank emails would otherwise count as duplicates
    const email = root.querySelector('#editAthleteEmail').value.trim() || null

    if (!name) { customAlert('Please enter a name'); return }

    const previousEmail = currentAthlete ? currentAthlete.email : null

    const { error } = await supabase
      .from('athletes')
      .update({ name, date_of_birth: dob, gender, height, email })
      .eq('id', athleteId)

    if (error) {
      console.log(error)
      if (error.code === '23505') {
        customAlert('Another athlete is already using that email')
      } else {
        customAlert('Something went wrong')
      }
      return
    }

    root.querySelector('#editAthleteModal').classList.remove('active')

    // Only a newly-added or changed email should trigger a fresh invite -
    // resaving unrelated fields shouldn't re-send one every time
    if (email && email !== previousEmail) {
      const inviteError = await sendInviteEmail(email, name)
      if (inviteError) {
        console.log('Error sending invite:', inviteError)
        customAlert('Athlete saved, but the invite email failed to send. Use "Resend Invite" or "Copy Invite Link" to try again.')
      }
    }

    // loadAthlete()/paintAthleteHeader() are split here (unlike the original
    // single-page site) so the profile header/title/Settings toggles still
    // repaint after this save, same as they do on first mount - see mount()
    const token = mountToken
    const ok = await loadAthlete(token)
    if (!nav.isCurrent(token)) return
    if (ok) paintAthleteHeader()
  })
}

// ==========================================================================
// ---- BODYWEIGHT ----
// Loads and draws the bodyweight trend chart on the profile header, and
// handles logging a new bodyweight entry.
// ==========================================================================
async function loadBodyweightGraph() {
  const token = mountToken
  const { data, error } = await supabase
    .from('bodyweight')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: true })

  if (!nav.isCurrent(token)) return
  const canvas = root.querySelector('#bodyweightGraph')
  const noDataMsg = root.querySelector('#noBodyweightMsg')

  if (!data || data.length === 0) {
    canvas.style.display = 'none'
    noDataMsg.style.display = 'block'
    return
  }

  noDataMsg.style.display = 'none'
  canvas.style.display = 'block'

  await loadChartJs()
  if (!nav.isCurrent(token)) return

  if (bodyweightChart) bodyweightChart.destroy()

  bodyweightChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: data.map(d => d.date),
      datasets: [{
        // Convert stored kg values to lbs on the fly if the user has lbs selected
        data: data.map(d => bodyweightUnit === 'kg' ? d.weight : +(d.weight * 2.20462).toFixed(1)),
        borderColor: '#4a4a8e',
        backgroundColor: 'rgba(74, 74, 142, 0.1)',
        borderWidth: 2,
        pointRadius: 3,
        tension: 0.3,
        fill: true
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: {
          ticks: { color: '#aaaacc', font: { size: 10 } },
          grid: { color: '#2a2a4e' }
        }
      }
    }
  })
}

// ---- Bodyweight logging, kg/lbs toggle, and Bodyweight Entries history ----
// (mirrors the metric ENTRIES MODAL above, but for the bodyweight table).
// Values are always stored in kg - bodyweightUnit only changes how they're shown.
function bindBodyweightEvents() {
  root.querySelector('#addBodyweightBtn').addEventListener('click', function() {
    root.querySelector('#bodyweightDate').valueAsDate = new Date()
    root.querySelector('#bodyweightModal').classList.add('active')
  })

  root.querySelector('#closeBodyweightBtn').addEventListener('click', function() {
    root.querySelector('#bodyweightModal').classList.remove('active')
  })

  root.querySelector('#cancelBodyweightBtn').addEventListener('click', function() {
    root.querySelector('#bodyweightModal').classList.remove('active')
  })

  // Saves a new bodyweight entry; always stores in kg regardless of input unit
  root.querySelector('#saveBodyweightBtn').addEventListener('click', async function() {
    const date = root.querySelector('#bodyweightDate').value
    const rawWeight = parseFloat(root.querySelector('#bodyweightValue').value)
    const inputUnit = root.querySelector('#bodyweightInputUnit').value
    const weight = inputUnit === 'lbs' ? +(rawWeight / 2.20462).toFixed(2) : rawWeight
    const notes = root.querySelector('#bodyweightNotes').value

    if (!date || !weight) { customAlert('Please fill in date and weight'); return }

    const { error } = await supabase
      .from('bodyweight')
      .insert([{ athlete_id: parseInt(athleteId), date, weight, notes }])

    if (error) { console.log(error); customAlert('Something went wrong'); return }

    root.querySelector('#bodyweightModal').classList.remove('active')
    root.querySelector('#bodyweightValue').value = ''
    root.querySelector('#bodyweightNotes').value = ''
    loadBodyweightGraph()
  })

  root.querySelector('#bwKgBtn').addEventListener('click', function() {
    bodyweightUnit = 'kg'
    root.querySelector('#bwKgBtn').classList.add('active')
    root.querySelector('#bwLbsBtn').classList.remove('active')
    loadBodyweightGraph()
  })

  root.querySelector('#bwLbsBtn').addEventListener('click', function() {
    bodyweightUnit = 'lbs'
    root.querySelector('#bwLbsBtn').classList.add('active')
    root.querySelector('#bwKgBtn').classList.remove('active')
    loadBodyweightGraph()
  })

  root.querySelector('#viewBWEntriesBtn').addEventListener('click', function() {
    root.querySelector('#bwEntriesModal').classList.add('active')
    loadBWEntries()
  })

  root.querySelector('#closeBWEntriesBtn').addEventListener('click', function() {
    root.querySelector('#bwEntriesModal').classList.remove('active')
  })

  root.querySelector('#cancelEditBWBtn').addEventListener('click', function() {
    root.querySelector('#editBWEntryModal').classList.remove('active')
  })

  root.querySelector('#saveEditBWBtn').addEventListener('click', async function() {
    const date = root.querySelector('#editBWDate').value
    const rawWeight = parseFloat(root.querySelector('#editBWValue').value)
    const unit = root.querySelector('#editBWUnit').value
    const weight = unit === 'lbs' ? +(rawWeight / 2.20462).toFixed(2) : rawWeight
    const notes = root.querySelector('#editBWNotes').value

    if (!date || !weight) { customAlert('Please fill in date and weight'); return }

    const { error } = await supabase
      .from('bodyweight')
      .update({ date, weight, notes })
      .eq('id', currentBWEntry.id)

    if (error) { customAlert('Something went wrong'); return }

    root.querySelector('#editBWEntryModal').classList.remove('active')
    loadBWEntries()
    loadBodyweightGraph()
  })
}

async function loadBWEntries() {
  const token = mountToken
  const { data, error } = await supabase
    .from('bodyweight')
    .select('*')
    .eq('athlete_id', athleteId)
    .order('date', { ascending: false })

  if (!nav.isCurrent(token)) return
  const list = root.querySelector('#bwEntriesList')

  if (!data || data.length === 0) {
    list.innerHTML = '<p style="color:#aaaacc;text-align:center;padding:20px">No entries yet</p>'
    return
  }

  list.innerHTML = `
    <table class="entries-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Weight</th>
          <th>Notes</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${data.map(m => `
          <tr>
            <td>${m.date}</td>
            <td>${bodyweightUnit === 'lbs' ? +(m.weight * 2.20462).toFixed(1) + ' lbs' : m.weight + ' kg'}</td>
            <td>${m.notes || '—'}</td>
            <td>
              <button class="btn-edit-entry" data-entry-id="${m.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg></button>
              <button class="btn-delete-measurement" data-entry-id="${m.id}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `

  list.querySelectorAll('.btn-delete-measurement').forEach(btn => {
    btn.addEventListener('click', async function() {
      const entryId = parseInt(this.dataset.entryId)
      if (!(await customConfirm('Delete this entry?'))) return

      const { error } = await supabase
        .from('bodyweight')
        .delete()
        .eq('id', entryId)

      if (error) { customAlert('Something went wrong'); return }

      loadBWEntries()
      loadBodyweightGraph()
    })
  })

  list.querySelectorAll('.btn-edit-entry').forEach(btn => {
    btn.addEventListener('click', function() {
      const entryId = parseInt(this.dataset.entryId)
      currentBWEntry = data.find(m => m.id === entryId)
      root.querySelector('#editBWDate').value = currentBWEntry.date
      root.querySelector('#editBWValue').value = currentBWEntry.weight
      root.querySelector('#editBWUnit').value = 'kg'
      root.querySelector('#editBWNotes').value = currentBWEntry.notes || ''
      root.querySelector('#editBWEntryModal').classList.add('active')
    })
  })
}

// ==========================================================================
// ---- % CHANGE EXPLANATION ----
// Opens a small modal that explains how the ▲/▼ % change badge on a metric
// card was calculated (which numbers were compared and why).
// ==========================================================================
function openChangeExplain(el) {
  const type = el.dataset.explainType
  const metricName = el.dataset.metricName
  const pct = parseFloat(el.dataset.pct)
  const higher = el.dataset.higher === 'true'
  const isPositive = higher ? pct > 0 : pct < 0
  const cssClass = pct === 0 ? 'neutral' : isPositive ? 'positive' : 'negative'
  const arrow = pct > 0 ? '▲' : '▼'

  root.querySelector('#changeExplainTitle').textContent = `${metricName} — Change Breakdown`

  let content = ''

  if (type === 'zone2') {
    // Zone2 breakdown: last-30-days avg vs previous-30-days avg
    const avg30 = parseFloat(el.dataset.avg30)
    const avgPrev = parseFloat(el.dataset.avgprev)
    content = `
      <div class="change-explain-row">
        <span class="change-explain-label">Last 30 days avg score</span>
        <span class="change-explain-value">${avg30}</span>
      </div>
      <div class="change-explain-row">
        <span class="change-explain-label">Previous 30 days avg score</span>
        <span class="change-explain-value">${avgPrev}</span>
      </div>
      <div class="change-explain-result metric-change ${cssClass}">
        ${arrow} ${Math.abs(pct)}% change in efficiency
      </div>
      <p style="color:#aaaacc; font-size:12px; margin-top:12px; text-align:center">
        Score = 1000 ÷ (pace × BPM) — higher is better
      </p>
    `
  } else if (type === 'period') {
    // Full graph modal breakdown: for a fixed window (1M/3M/6M/1Y), compares
    // that period's avg to the same-length period right before it. "All" has
    // no equivalent "previous" period, so it falls back to an earlier-half
    // vs recent-half split of the whole history instead.
    const periodLabel = el.dataset.periodLabel
    const isAllTime = periodLabel === 'All'
    const previousAvg = parseFloat(el.dataset.firstAvg)
    const currentAvg = parseFloat(el.dataset.secondAvg)
    const unit = el.dataset.unit
    const isPogo = el.dataset.metricType === 'pogo'
    const isZone2 = el.dataset.metricType === 'zone2'

    const formatVal = v => isZone2 || isPogo ? v : `${convertValue(v, unit).text} ${convertValue(v, unit).unit}`.trim()
    const valueLabel = isZone2 ? 'score' : isPogo ? 'RSI' : 'value'
    const previousLabel = isAllTime ? `Earlier half avg ${valueLabel}` : `Previous ${periodLabel} avg ${valueLabel}`
    const currentLabel = isAllTime ? `Recent half avg ${valueLabel}` : `This ${periodLabel} avg ${valueLabel}`

    content = `
      <div class="change-explain-row">
        <span class="change-explain-label">${previousLabel}</span>
        <span class="change-explain-value">${formatVal(previousAvg)}</span>
      </div>
      <div class="change-explain-row">
        <span class="change-explain-label">${currentLabel}</span>
        <span class="change-explain-value">${formatVal(currentAvg)}</span>
      </div>
      <div class="change-explain-result metric-change ${cssClass}">
        ${arrow} ${Math.abs(pct)}% within the ${periodLabel} view
      </div>
      <p style="color:#aaaacc; font-size:12px; margin-top:12px; text-align:center">
        ${isAllTime
          ? 'All time has no earlier equivalent period, so this compares the earlier half of the athlete’s history to the more recent half.'
          : `Compares the selected ${periodLabel} period to the ${periodLabel} right before it.`}
        Change the time filter above to see a different range.
        ${higher ? ' Higher is better for this metric.' : ' Lower is better for this metric.'}
      </p>
    `
  } else {
    // Simple/pogo breakdown: latest entry vs avg of previous 5 entries
    const latest = parseFloat(el.dataset.latest)
    const avgPrev = parseFloat(el.dataset.avgprev)
    const unit = el.dataset.unit
    const isPogo = el.dataset.metricType === 'pogo'

    const convertedLatest = isPogo ? { text: latest, unit: '' } : convertValue(latest, unit)
    const convertedAvg = isPogo ? { text: avgPrev, unit: '' } : convertValue(avgPrev, unit)
    const displayLatest = `${convertedLatest.text} ${convertedLatest.unit}`.trim()
    const displayAvg = `${convertedAvg.text} ${convertedAvg.unit}`.trim()
    const valueLabel = isPogo ? 'RSI Score' : 'Latest entry'
    const avgLabel = isPogo ? 'Avg RSI of previous 5 entries' : 'Avg of previous 5 entries'

    content = `
      <div class="change-explain-row">
        <span class="change-explain-label">${valueLabel}</span>
        <span class="change-explain-value">${displayLatest}</span>
      </div>
      <div class="change-explain-row">
        <span class="change-explain-label">${avgLabel}</span>
        <span class="change-explain-value">${displayAvg}</span>
      </div>
      <div class="change-explain-result metric-change ${cssClass}">
        ${arrow} ${Math.abs(pct)}% vs previous 5 entries
      </div>
      <p style="color:#aaaacc; font-size:12px; margin-top:12px; text-align:center">
        ${higher ? 'Higher is better for this metric' : 'Lower is better for this metric'}
      </p>
    `
  }

  root.querySelector('#changeExplainContent').innerHTML = content
  root.querySelector('#changeExplainModal').classList.add('active')
}

function bindChangeExplainEvents() {
  root.querySelector('#closeChangeExplainBtn').addEventListener('click', function() {
    root.querySelector('#changeExplainModal').classList.remove('active')
  })
}

// ==========================================================================
// ---- PDF PROGRESS REPORT ----
// "Generate Report" button at the top of the Metrics tab opens a checklist
// of sections (only ones with real logged data are offered) + a 1/3/6/9/12
// month picker, then builds a PDF client-side with jsPDF and opens it in a
// new tab. No saved template - the checklist is picked fresh every time.
// ==========================================================================
function bindReportEvents() {
  root.querySelector('#generateReportBtn').addEventListener('click', openReportBuilderModal)

  root.querySelector('#closeReportBuilderModalBtn').addEventListener('click', function() {
    root.querySelector('#reportBuilderModal').classList.remove('active')
  })

  root.querySelector('#reportSectionChecklist').addEventListener('click', function(e) {
    const btn = e.target.closest('.chip-btn')
    if (!btn) return
    const key = btn.dataset.key
    if (reportSelectedSections.has(key)) {
      reportSelectedSections.delete(key)
      btn.classList.remove('selected')
    } else {
      reportSelectedSections.add(key)
      btn.classList.add('selected')
    }
  })

  root.querySelector('#reportMonthsRow').addEventListener('click', function(e) {
    const btn = e.target.closest('.time-filter-btn')
    if (!btn) return
    root.querySelectorAll('#reportMonthsRow .time-filter-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    reportSelectedMonths = parseInt(btn.dataset.months)
  })

  root.querySelector('#generatePdfBtn').addEventListener('click', generateReportPDF)
}

async function openReportBuilderModal() {
  const token = mountToken
  root.querySelector('#reportBuilderModal').classList.add('active')
  root.querySelector('#reportSectionChecklist').innerHTML = '<p class="no-metrics">Checking available data...</p>'
  root.querySelector('#reportSendToChatLabel').textContent = `Also send to ${currentAthlete ? currentAthlete.name : 'athlete'} in chat`
  root.querySelector('#reportSendToChat').checked = false
  reportDataCache = await fetchReportData()
  if (!nav.isCurrent(token)) return
  if (!reportDataCache) {
    root.querySelector('#reportBuilderModal').classList.remove('active')
    return
  }
  reportSelectedSections = new Set(reportDataCache.availableSections.map(s => s.key))
  renderReportChecklist()
}

// One batch of unbounded-history queries, cached in reportDataCache for the
// lifetime of one modal-open - both the eligibility checklist AND the final
// PDF read from this same cache, filtered to whichever date range the coach
// picks, so there's exactly one round-trip to Supabase per report attempt.
async function fetchReportData() {
  const [
    { data: programs, error: programsError },
    { data: sessions, error: sessionsError }
  ] = await Promise.all([
    window.fetchWithRetry((signal) => supabase
      .from('programs')
      .select('*, program_weeks(*, program_days(*, program_exercises(*, exercises!exercise_id(id, name, type, tracks_weight, foot_contacts, intensity_tier))))')
      .eq('athlete_id', athleteId)
      .eq('is_template', false)
      .abortSignal(signal)
    ),
    window.fetchWithRetry((signal) => supabase
      .from('workout_sessions')
      .select('*')
      .eq('athlete_id', athleteId)
      .not('ended_at', 'is', null)
      .order('started_at', { ascending: true })
      .abortSignal(signal)
    )
  ])

  if (programsError || sessionsError) {
    console.log('Error loading report data:', programsError || sessionsError)
    customAlert('Something went wrong loading report data - check your connection and try again')
    return null
  }

  // Same workoutEntries/peInfoById shape loadOverviewStats already builds,
  // just unbounded (no 90-day cap) since PR baselines and a 12-month report
  // both need full history
  const workoutEntries = [] // { dateStr, exercises }
  const peInfoById = {} // program_exercise_id -> joined exercises row
  for (const program of programs) {
    for (const week of program.program_weeks) {
      for (const day of week.program_days) {
        const dateStr = day.date_override || resolveDateOv(program.start_date, week.week_number, day.day_number)
        workoutEntries.push({ dateStr, exercises: day.program_exercises })
        for (const pe of day.program_exercises) {
          // A per-instance "Adjust Fields" override (Workout Builder) wins
          // over the exercise's own tracks_weight default when present -
          // durationStatsForRange() below reads .tracks_weight off this
          // same object, so it needs to see the resolved value too
          if (pe.exercises) {
            const tracksWeight = pe.tracks_weight_override != null ? pe.tracks_weight_override : !!pe.exercises.tracks_weight
            peInfoById[pe.id] = { ...pe.exercises, tracks_weight: tracksWeight }
          }
        }
      }
    }
  }

  const peIds = Object.keys(peInfoById)
  let logSets = []
  if (peIds.length > 0) {
    const { data, error } = await window.fetchWithRetry((signal) => supabase
      .from('exercise_log_sets')
      .select('*')
      .in('program_exercise_id', peIds)
      .not('completed_at', 'is', null)
      .order('date', { ascending: true })
      .abortSignal(signal)
    )
    if (error) {
      console.log('Error loading report log sets:', error)
      customAlert('Something went wrong loading report data - check your connection and try again')
      return null
    }
    logSets = data || []
  }

  // Eligibility - a section is only offered if the athlete actually has
  // qualifying data, anywhere in their history
  const availableSections = []
  for (const am of athleteMetrics) {
    if (!am.metrics) continue
    if (allMeasurementsCache.some(m => m.metric_id === am.metrics.id)) {
      availableSections.push({ key: `metric:${am.metrics.id}`, label: am.metrics.name, kind: 'metric', metric: am.metrics })
    }
  }
  if (sessions.length > 0) {
    availableSections.push({ key: 'overview', label: 'Workout Overview', kind: 'overview' })
  }
  if (logSets.some(s => { const ex = peInfoById[s.program_exercise_id]; return ex && ex.type === 'plyometric' && ex.foot_contacts })) {
    availableSections.push({ key: 'plyo', label: 'Plyometric Load', kind: 'plyo' })
  }

  return { workoutEntries, peInfoById, logSets, sessions, availableSections }
}

function renderReportChecklist() {
  const container = root.querySelector('#reportSectionChecklist')
  if (reportDataCache.availableSections.length === 0) {
    container.innerHTML = '<p class="no-metrics">No logged data yet for this athlete - nothing to report on.</p>'
    return
  }
  container.innerHTML = reportDataCache.availableSections.map(s => `
    <button type="button" class="chip-btn selected" data-key="${s.key}">${s.label}</button>
  `).join('')
}

// { from, to } is the chosen report window; { prevFrom, prevTo } is the
// immediately-preceding period of equal length, used for the "vs previous
// period" deltas that make this read as a progress report, not a snapshot
function buildReportRange(months) {
  const to = new Date()
  const from = new Date(to)
  from.setMonth(from.getMonth() - months)
  const prevTo = new Date(from)
  prevTo.setDate(prevTo.getDate() - 1)
  const prevFrom = new Date(prevTo)
  prevFrom.setMonth(prevFrom.getMonth() - months)
  return {
    from: toDateStrOv(from), to: toDateStrOv(to),
    prevFrom: toDateStrOv(prevFrom), prevTo: toDateStrOv(prevTo)
  }
}

// ---- Section calculators - pure functions, no DOM/network, operate on the
// already-fetched reportDataCache plus a date range from buildReportRange ----

// Same rule completionRate() (loadOverviewStats) uses, generalized from a
// fixed windowDays to an arbitrary [from, to] range - including the "today
// isn't over yet" exception, so a report window ending today (as every
// report window does, see buildReportRange) doesn't count an unfinished
// same-day workout as missed
function completionRateForRange(workoutEntries, logSetsByPE, from, to) {
  const todayStr = toDateStrOv(new Date())
  let scheduled = 0
  let completed = 0
  for (const entry of workoutEntries) {
    if (entry.dateStr < from || entry.dateStr > to) continue
    if (entry.exercises.length === 0) continue
    let totalSets = 0
    let doneSets = 0
    for (const pe of entry.exercises) {
      const prescribed = pe.prescribed_sets || 1
      totalSets += prescribed
      const logged = (logSetsByPE[pe.id] || []).filter(s => s.completed_at && s.set_number <= prescribed)
      doneSets += Math.min(logged.length, prescribed)
    }
    const workoutDone = totalSets > 0 && (doneSets / totalSets) >= 0.5
    if (entry.dateStr === todayStr && !workoutDone) continue
    scheduled++
    if (workoutDone) completed++
  }
  return scheduled === 0 ? null : Math.round((completed / scheduled) * 100)
}

function volumeForRange(logSets, peInfoById, from, to) {
  return logSets
    .filter(s => s.date >= from && s.date <= to && peInfoById[s.program_exercise_id] && peInfoById[s.program_exercise_id].tracks_weight)
    .reduce((sum, s) => sum + setVolumeOv(s), 0)
}

function durationStatsForRange(sessions, from, to) {
  const inRange = sessions.filter(s => s.local_date >= from && s.local_date <= to)
  if (inRange.length === 0) return null
  const totalMinutes = inRange.reduce((sum, s) => sum + (new Date(s.ended_at) - new Date(s.started_at)) / 60000, 0)
  return Math.round(totalMinutes / inRange.length)
}

function computeWorkoutOverviewSection(cache, range) {
  const logSetsByPE = {}
  for (const row of cache.logSets) {
    if (!logSetsByPE[row.program_exercise_id]) logSetsByPE[row.program_exercise_id] = []
    logSetsByPE[row.program_exercise_id].push(row)
  }
  return {
    completion: completionRateForRange(cache.workoutEntries, logSetsByPE, range.from, range.to),
    prevCompletion: completionRateForRange(cache.workoutEntries, logSetsByPE, range.prevFrom, range.prevTo),
    volumeKg: Math.round(volumeForRange(cache.logSets, cache.peInfoById, range.from, range.to)),
    prevVolumeKg: Math.round(volumeForRange(cache.logSets, cache.peInfoById, range.prevFrom, range.prevTo)),
    avgDurationMin: durationStatsForRange(cache.sessions, range.from, range.to),
    prevAvgDurationMin: durationStatsForRange(cache.sessions, range.prevFrom, range.prevTo)
  }
}

// Same 30-days-vs-previous-30-days formula the Metrics tab's zone2 change
// badge uses (renderMetrics()), so the report's % always matches the app's
function zone2ChangePct(allForMetric) {
  const now = new Date()
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const sixtyDaysAgo = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  const last30 = allForMetric.filter(m => m.date >= thirtyDaysAgo)
  const prev30 = allForMetric.filter(m => m.date >= sixtyDaysAgo && m.date < thirtyDaysAgo)
  if (last30.length === 0 || prev30.length === 0) return null
  const avg30 = last30.reduce((sum, m) => sum + m.value, 0) / last30.length
  const avgPrev = prev30.reduce((sum, m) => sum + m.value, 0) / prev30.length
  if (!avgPrev) return null
  return +(((avg30 - avgPrev) / avgPrev) * 100).toFixed(1)
}

// Same "latest vs avg of previous 5 entries" formula the Metrics tab uses
// for every non-zone2 metric type - also always matches the app's number
function simpleChangePct(allForMetric, getValue) {
  if (allForMetric.length < 2) return null
  const latestVal = getValue(allForMetric[allForMetric.length - 1])
  const previous = allForMetric.slice(0, -1).slice(-5)
  const avgPrev = previous.reduce((sum, m) => sum + getValue(m), 0) / previous.length
  if (!avgPrev) return null
  return +(((latestVal - avgPrev) / avgPrev) * 100).toFixed(1)
}

// Converts a metric's raw stored values into whatever unit actually gets
// charted, so the trend chart's axis is never in a different unit than the
// headline "Latest" tile next to it (ft/in display units aren't directly
// plottable as feet'inches" text, so both chart as inches instead)
function chartUnitAndValues(metric, rawValues) {
  if (metric.type === 'pogo') return { unit: 'RSI', values: rawValues }
  if (metric.type === 'zone2') return { unit: 'Score', values: rawValues }
  const displayUnit = metric.display_unit
  if (displayUnit === 'in' || displayUnit === 'ft') {
    return { unit: 'in', values: rawValues.map(v => +(v / 2.54).toFixed(1)) }
  }
  return { unit: displayUnit || '', values: rawValues }
}

// "Latest" + its % change always reuse the exact same formulas/history the
// Metrics tab itself uses (see zone2ChangePct/simpleChangePct above), so
// they can never disagree with what the coach already sees there - only
// the trend chart is actually scoped to the chosen report window
function computeCustomMetricSection(metric, range) {
  const allForMetric = allMeasurementsCache
    .filter(m => m.metric_id === metric.id)
    .sort((a, b) => a.date.localeCompare(b.date))

  if (allForMetric.length === 0) return { metric, hasData: false }

  const getValue = m => metric.type === 'pogo' ? m.rsi : m.value
  const latestValue = getValue(allForMetric[allForMetric.length - 1])
  const pct = metric.type === 'zone2' ? zone2ChangePct(allForMetric) : simpleChangePct(allForMetric, getValue)

  const inRange = allForMetric.filter(m => m.date >= range.from && m.date <= range.to)
  const { unit: chartUnit, values: chartValues } = chartUnitAndValues(metric, inRange.map(getValue))

  return { metric, hasData: true, latestValue, pct, dates: inRange.map(m => m.date), chartValues, chartUnit }
}

// Same formula as the athlete app's per-session plyo load (foot_contacts x
// intensity multiplier x completed sets), summed per date across the whole
// report window, plus the equal-length prior period for a delta callout
function computePlyoSection(cache, range) {
  const multiplier = { low: 1, moderate: 1.5, high: 2 }
  const byDate = {}
  for (const s of cache.logSets) {
    const ex = cache.peInfoById[s.program_exercise_id]
    if (!ex || ex.type !== 'plyometric' || !ex.foot_contacts) continue
    const load = ex.foot_contacts * (multiplier[ex.intensity_tier] || 1)
    byDate[s.date] = (byDate[s.date] || 0) + load
  }

  const inRangeDates = Object.keys(byDate).filter(d => d >= range.from && d <= range.to).sort()
  const prevDates = Object.keys(byDate).filter(d => d >= range.prevFrom && d <= range.prevTo)

  return {
    hasData: inRangeDates.length > 0,
    dates: inRangeDates,
    values: inRangeDates.map(d => Math.round(byDate[d])),
    totalInRange: Math.round(inRangeDates.reduce((sum, d) => sum + byDate[d], 0)),
    totalPrev: Math.round(prevDates.reduce((sum, d) => sum + byDate[d], 0))
  }
}

// Loads an image from this same origin (the TBFlog logo) and re-draws it
// onto a canvas so it can be embedded in the PDF as a data URL - resolves
// null on any failure so a broken/slow logo load never blocks the report
function loadImageAsDataUrl(url) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext('2d').drawImage(img, 0, 0)
      resolve({ dataUrl: canvas.toDataURL('image/png'), width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}

// Same value+unit formatting the Metrics tab cards already use
// (renderMetrics()) - pogo shows "RSI", zone2 shows "Score", everything
// else goes through convertValue() for its real display unit (cm/kg/etc)
function formatMetricValue(metric, value) {
  if (metric.type === 'pogo') return `${value} RSI`
  if (metric.type === 'zone2') return `Score: ${value}`
  const converted = convertValue(value, metric.display_unit)
  return converted.unit ? `${converted.text} ${converted.unit}` : `${converted.text}`
}

// Renders a Chart.js line chart into a throwaway off-screen canvas (never
// attached to the page, so this never disturbs what's visible on the
// Metrics tab), forces a white background (these charts are transparent by
// default against this app's dark theme, which would look wrong on a white
// PDF page), and returns the new y-cursor position after placing the image.
// The chart is destroyed synchronously right after its image is grabbed, so
// (unlike fullChart/bodyweightChart/volumeChart/miniChartInstances) there's
// nothing left over for unmount() to track.
function drawTrendChart(doc, labels, values, title, margin, y, pageWidth, heightMm) {
  // Canvas is built at EXACTLY the same aspect ratio as the box it'll be
  // placed into below - addImage stretches to fit whatever width/height
  // it's given, so any mismatch here previously showed up as a visibly
  // squashed/compressed chart
  const boxWidthMm = pageWidth - margin * 2
  const canvasWidth = 1000
  const canvasHeight = Math.round(canvasWidth / (boxWidthMm / heightMm))
  const canvas = document.createElement('canvas')
  canvas.width = canvasWidth
  canvas.height = canvasHeight
  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: '#4a4a8e',
        backgroundColor: 'rgba(74,74,142,0.12)',
        fill: true,
        tension: 0.35,
        borderWidth: 3,
        pointRadius: 0
      }]
    },
    options: {
      responsive: false,
      animation: false,
      // devicePixelRatio 1, not 2 - this chart only ever gets printed into a
      // ~62mm-tall PDF box, where a 1000px-wide source is already ~140 DPI;
      // doubling that (as devicePixelRatio: 2 used to) quadrupled every
      // chart's exported PNG bytes for no visible gain, and a report with
      // many tracked metrics selected could add up past the storage
      // bucket's upload size limit
      devicePixelRatio: 1,
      layout: { padding: { top: 6, right: 10, bottom: 2, left: 4 } },
      plugins: {
        legend: { display: false },
        title: { display: !!title, text: title, color: '#333333', font: { size: 15, weight: 'bold' }, padding: { bottom: 10 } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#888888', font: { size: 11 }, autoSkip: true, maxTicksLimit: 6 } },
        y: { grid: { color: '#eeeeee' }, ticks: { color: '#888888', font: { size: 11 } } }
      }
    },
    plugins: [{
      id: 'whiteBackground',
      beforeDraw: (c) => {
        const ctx = c.canvas.getContext('2d')
        ctx.save()
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, c.width, c.height)
        ctx.restore()
      }
    }]
  })

  const imgData = chart.toBase64Image()
  chart.destroy()

  doc.addImage(imgData, 'PNG', margin, y, pageWidth - margin * 2, heightMm)
  return y + heightMm + 4
}

async function generateReportPDF() {
  if (!reportDataCache) return

  // await loadJsPdf()/loadChartJs() replace the old `if (!window.jspdf)`
  // guard - see this file's top banner comment. Both are cached (see
  // vendor.js) so this is a no-op after the first report of a visit.
  await loadJsPdf()
  await loadChartJs()
  if (!root) return

  const range = buildReportRange(reportSelectedMonths)
  const MONTHS_LABELS = { 1: 'Last Month', 3: 'Last 3 Months', 6: 'Last 6 Months', 9: 'Last 9 Months', 12: 'Last 12 Months' }
  const periodLabel = MONTHS_LABELS[reportSelectedMonths] || `Last ${reportSelectedMonths} Months`

  const btn = root.querySelector('#generatePdfBtn')
  const originalBtnHTML = btn.innerHTML // restored in finally - textContent below would otherwise lose the button's svg icon
  btn.disabled = true
  btn.textContent = 'Generating…'

  try {
    const logo = await loadImageAsDataUrl('logo.png')
    if (!root) return

    const { jsPDF } = window.jspdf
    const doc = new jsPDF()
    const pageWidth = doc.internal.pageSize.getWidth()
    const pageHeight = doc.internal.pageSize.getHeight()
    const margin = 15
    let y = margin

    // Spacing constants, shared between the actual drawing code below and
    // the per-section height estimates sectionBlock() uses to decide
    // whether a whole section (heading + stats + chart) needs to move to
    // the next page together - keeping these in one place means the
    // estimate can never drift out of sync with what's actually drawn
    const HEADING_H = 8, HEADING_GAP = 3
    const TILE_H = 26, TILE_GAP = 6
    const CHART_H = 62, CHART_GAP = 5
    const EMPTY_LINE_H = 8
    const SECTION_GAP = 3
    const HEADING_TOTAL = HEADING_H + HEADING_GAP
    const TILE_TOTAL = TILE_H + TILE_GAP
    const CHART_TOTAL = CHART_H + CHART_GAP

    function ensureSpace(blockHeight) {
      if (y + blockHeight > pageHeight - margin) {
        doc.addPage()
        y = margin
      }
    }

    // Reserves room for an ENTIRE section (heading + stats + chart) in one
    // go, so a section only ever splits across a page break if it's too
    // tall to fit on any single page - never mid-way, e.g. heading+stats on
    // one page and its chart alone on the next
    function sectionBlock(totalHeight, drawFn) {
      if (totalHeight <= pageHeight - margin * 2) ensureSpace(totalHeight)
      drawFn()
    }

    // Colored banner bar, white bold text - reads as a real report section
    // divider rather than a plain bold line of text
    function heading(text) {
      ensureSpace(HEADING_TOTAL)
      doc.setFillColor(74, 74, 142)
      doc.rect(margin, y, pageWidth - margin * 2, HEADING_H, 'F')
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(12)
      doc.setTextColor(255, 255, 255)
      doc.text(text, margin + 3, y + 5.5)
      doc.setTextColor(0, 0, 0)
      y += HEADING_TOTAL
    }

    // Boxed "stat card" tiles, same visual idea as the app's own .stat-item
    // tiles on the Overview/Metrics tabs - laid out left-aligned at a fixed
    // width so a single tile doesn't stretch awkwardly across the page.
    // The % change is drawn big and bold, since "did this go up or down" is
    // meant to be readable at a glance, not squinted at.
    function statTiles(items) {
      const tileWidth = 50
      const gap = 4
      ensureSpace(TILE_TOTAL)
      items.forEach((item, i) => {
        const x = margin + i * (tileWidth + gap)
        doc.setDrawColor(210, 210, 220)
        doc.setLineWidth(0.3)
        doc.roundedRect(x, y, tileWidth, TILE_H, 2, 2, 'S')

        doc.setFont('helvetica', 'bold')
        doc.setFontSize(12.5)
        doc.setTextColor(30, 30, 50)
        doc.text(String(item.value), x + tileWidth / 2, y + 9, { align: 'center' })

        doc.setFont('helvetica', 'normal')
        doc.setFontSize(7.5)
        doc.setTextColor(120, 120, 130)
        doc.text(item.label, x + tileWidth / 2, y + 14, { align: 'center' })

        if (item.delta) {
          // deltaPositive (when given) overrides the sign-based color guess,
          // since a metric can be "lower is better" - a negative change on
          // those should read green, not red, matching the app's own rule
          let isUp, isDown
          if (item.deltaPositive === true) { isUp = true; isDown = false }
          else if (item.deltaPositive === false) { isUp = false; isDown = true }
          else { isUp = item.delta.startsWith('+'); isDown = item.delta.startsWith('-') }
          doc.setFont('helvetica', 'bold')
          doc.setFontSize(11)
          if (isUp) doc.setTextColor(40, 140, 90)
          else if (isDown) doc.setTextColor(190, 70, 70)
          else doc.setTextColor(120, 120, 130)
          doc.text(item.delta, x + tileWidth / 2, y + 21, { align: 'center' })
          doc.setFont('helvetica', 'normal')
        }
      })
      doc.setTextColor(0, 0, 0)
      y += TILE_TOTAL
    }

    function emptyStateLine(text) {
      ensureSpace(EMPTY_LINE_H)
      doc.setFont('helvetica', 'italic')
      doc.setFontSize(9.5)
      doc.setTextColor(140, 140, 150)
      doc.text(text, margin, y)
      doc.setTextColor(0, 0, 0)
      doc.setFont('helvetica', 'normal')
      y += EMPTY_LINE_H
    }

    // jsPDF's built-in fonts don't support the ▲/▼ characters used
    // elsewhere in the app (they're outside WinAnsi encoding and render as
    // garbled glyphs, e.g. a stray superscript mark next to the %) - a
    // leading +/- sign is fully supported and reads just as clearly
    function deltaText(current, previous) {
      if (previous == null || current == null || previous === 0) return null
      const pct = Math.round(((current - previous) / Math.abs(previous)) * 100)
      if (pct === 0) return null
      return `${pct > 0 ? '+' : ''}${pct}%`
    }

    // ---- Header: logo + athlete name/title on the left, the chosen time
    // period as its own large callout on the right (so which period this
    // report covers is visible at a glance, not buried in small print) ----
    const logoHeight = 22
    let logoWidth = 0
    if (logo) {
      logoWidth = (logo.width / logo.height) * logoHeight
      doc.addImage(logo.dataUrl, 'PNG', margin, y, logoWidth, logoHeight)
    }
    const textX = margin + (logo ? logoWidth + 7 : 0)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(18)
    doc.setTextColor(30, 30, 50)
    doc.text(currentAthlete ? currentAthlete.name : 'Athlete', textX, y + 8)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9.5)
    doc.setTextColor(74, 74, 142)
    doc.text('PHYSICAL ABILITY REPORT', textX, y + 14)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(130, 130, 140)
    doc.text(`Generated ${toDateStrOv(new Date())}`, textX, y + 19.5)

    // Right-aligned period callout - the single biggest piece of text in
    // the header, since "which period is this" is the first thing a coach
    // should be able to tell at a glance
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(20)
    doc.setTextColor(74, 74, 142)
    doc.text(periodLabel, pageWidth - margin, y + 10, { align: 'right' })

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    doc.setTextColor(130, 130, 140)
    doc.text(`${range.from} to ${range.to}`, pageWidth - margin, y + 16, { align: 'right' })

    doc.setTextColor(0, 0, 0)
    y += logoHeight + 6

    doc.setDrawColor(74, 74, 142)
    doc.setLineWidth(0.8)
    doc.line(margin, y, pageWidth - margin, y)
    y += 9

    for (const section of reportDataCache.availableSections) {
      if (!reportSelectedSections.has(section.key)) continue

      if (section.kind === 'overview') {
        const s = computeWorkoutOverviewSection(reportDataCache, range)
        sectionBlock(HEADING_TOTAL + TILE_TOTAL + SECTION_GAP, () => {
          heading('Workout Overview')
          statTiles([
            { label: 'Completion Rate', value: s.completion === null ? '—' : `${s.completion}%`, delta: deltaText(s.completion, s.prevCompletion) },
            { label: 'Total Volume', value: `${s.volumeKg.toLocaleString()}kg`, delta: deltaText(s.volumeKg, s.prevVolumeKg) },
            { label: 'Avg Session Duration', value: s.avgDurationMin === null ? '—' : formatDurationOv(s.avgDurationMin), delta: deltaText(s.avgDurationMin, s.prevAvgDurationMin) }
          ])
          y += SECTION_GAP
        })
      } else if (section.kind === 'plyo') {
        const s = computePlyoSection(reportDataCache, range)
        // A trend line needs at least 2 points IN THIS WINDOW - a short
        // window (e.g. 1 month) legitimately has 0 or 1 some of the time,
        // which isn't a bug, so say so instead of just showing nothing
        const hasChart = s.values.length > 1
        sectionBlock(HEADING_TOTAL + TILE_TOTAL + (hasChart ? CHART_TOTAL : EMPTY_LINE_H) + SECTION_GAP, () => {
          heading('Plyometric Load')
          statTiles([{ label: 'Total Load', value: s.totalInRange.toLocaleString(), delta: deltaText(s.totalInRange, s.totalPrev) }])
          if (hasChart) y = drawTrendChart(doc, s.dates, s.values, 'Plyometric Load Trend', margin, y, pageWidth, CHART_H)
          else emptyStateLine('Not enough data in this period to chart a trend.')
          y += SECTION_GAP
        })
      } else if (section.kind === 'metric') {
        const s = computeCustomMetricSection(section.metric, range)
        if (!s.hasData) {
          sectionBlock(HEADING_TOTAL + EMPTY_LINE_H + SECTION_GAP, () => {
            heading(section.metric.name)
            emptyStateLine('No data logged yet.')
            y += SECTION_GAP
          })
        } else {
          const hasChart = s.chartValues.length > 1
          const pctDelta = s.pct === null ? null : `${s.pct > 0 ? '+' : ''}${s.pct}%`
          const deltaPositive = s.pct === null || s.pct === 0 ? undefined : (section.metric.higher_is_better ? s.pct > 0 : s.pct < 0)
          sectionBlock(HEADING_TOTAL + TILE_TOTAL + (hasChart ? CHART_TOTAL : EMPTY_LINE_H) + SECTION_GAP, () => {
            heading(section.metric.name)
            statTiles([{ label: 'Latest', value: formatMetricValue(section.metric, s.latestValue), delta: pctDelta, deltaPositive }])
            if (hasChart) {
              const title = `${section.metric.name} Trend${s.chartUnit ? ' (' + s.chartUnit + ')' : ''}`
              y = drawTrendChart(doc, s.dates, s.chartValues, title, margin, y, pageWidth, CHART_H)
            } else {
              emptyStateLine('Not enough data in this period to chart a trend.')
            }
            y += SECTION_GAP
          })
        }
      }
    }

    const blobUrl = doc.output('bloburl')
    window.open(blobUrl, '_blank')
    root.querySelector('#reportBuilderModal').classList.remove('active')

    if (root.querySelector('#reportSendToChat').checked) {
      await shareReportWithAthlete(doc, periodLabel)
    }
  } catch (err) {
    console.log('Error generating report PDF:', err)
    customAlert('Something went wrong generating the PDF - please try again')
  } finally {
    if (root) { btn.disabled = false; btn.innerHTML = originalBtnHTML }
  }
}

// Uploads the just-generated PDF to the chat-attachments bucket (same
// {coach_id}/{uuid}.ext convention as the stretch-videos bucket) and drops
// it into this athlete's chat as a message with a pdf_url - shows up next
// time the coach opens communication.html's Communication inbox for this
// athlete (chat lives there now, not on this page). Only runs when the
// "Also send to chat" checkbox in the Report Builder modal was on, chosen
// up front instead of a confirm() popup after the PDF already opened.
async function shareReportWithAthlete(doc, periodLabel) {
  try {
    const blob = doc.output('blob')
    const path = `${coachId()}/${crypto.randomUUID()}.pdf`
    const { error: uploadError } = await supabase.storage.from('chat-attachments').upload(path, blob, { contentType: 'application/pdf' })
    if (uploadError) {
      console.log('Error uploading report:', uploadError)
      customAlert('Something went wrong sharing the report')
      return
    }
    const pdfUrl = supabase.storage.from('chat-attachments').getPublicUrl(path).data.publicUrl

    const { error } = await supabase.from('chat_messages').insert([{
      coach_id: coachId(),
      athlete_id: athleteId,
      sender: 'coach',
      message: `📄 Progress Report (${periodLabel})`,
      pdf_url: pdfUrl
    }])
    if (error) {
      console.log('Error sharing report:', error)
      customAlert('Something went wrong sharing the report')
      return
    }

    if (currentAthlete.user_id) {
      const url = new URL('../athlete-app/dashboard.html', window.location.href).href
      sendPush(supabase, currentAthlete.user_id, 'TBFlog', 'Your coach shared a progress report', url) // not awaited
    }

    if (!root) return
    showToast(`Sent to ${currentAthlete.name}'s chat ✓`)
  } catch (err) {
    console.log('Error sharing report:', err)
    customAlert('Something went wrong sharing the report')
  }
}

// Brief bottom-center confirmation that fades itself out - for background
// actions (like the chat share above) that have no other visible result on
// this page, so the coach isn't left guessing whether it worked. Populates
// the same module-level toastHideTimer declared in the state section above
// (cleared in unmount()), not a new one.
function showToast(message) {
  const el = root.querySelector('#pageToast')
  el.textContent = message
  el.classList.add('active')
  clearTimeout(toastHideTimer)
  toastHideTimer = setTimeout(() => el.classList.remove('active'), 3000)
}

