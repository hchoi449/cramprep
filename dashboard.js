(function () {
  const STATUS_KEY = 'tbp_dashboard_status';
  const TIMEZONE = 'America/New_York';
  const TIMEZONE_LABEL = 'ET';
  const SUBJECT_KEYWORDS = [
    { label: 'Algebra I', match: ['algebra 1', 'algebra i', 'alg i'] },
    { label: 'Algebra II', match: ['algebra 2', 'algebra ii', 'alg ii'] },
    { label: 'Geometry', match: ['geometry', 'geom'] },
    { label: 'Pre-Calculus', match: ['precalculus', 'pre-calculus', 'pre calc', 'pre-calc'] },
    { label: 'Calculus', match: ['calculus', 'calc'] },
    { label: 'Statistics', match: ['statistics', 'stats'] },
    { label: 'Physics', match: ['physics', 'phys'] },
    { label: 'Chemistry', match: ['chemistry', 'chem'] },
    { label: 'Biology', match: ['biology', 'bio'] },
    { label: 'English', match: ['english', 'ela', 'literature', 'lit'] },
    { label: 'History', match: ['history', 'world history', 'us history', 'government'] },
    { label: 'Economics', match: ['economics', 'econ', 'microeconomics', 'macroeconomics'] },
    { label: 'Marketing', match: ['marketing'] },
    { label: 'Computer Science', match: ['computer science', 'cs', 'programming', 'coding'] },
    { label: 'Spanish', match: ['spanish'] },
    { label: 'French', match: ['french'] },
    { label: 'Latin', match: ['latin'] },
    { label: 'SAT Prep', match: ['sat', 'psat'] },
    { label: 'ACT Prep', match: ['act'] },
  ];

  const SUBJECT_COLOR_PALETTE = [
    { bg: '#dfc9ff', border: '#bea1f5', text: '#3b2169' },
    { bg: '#c8e2ff', border: '#9ec4f5', text: '#12385c' },
    { bg: '#c9f0e0', border: '#9dd8bf', text: '#1d4030' },
    { bg: '#ffd7b5', border: '#f6b987', text: '#5c3314' },
    { bg: '#ffc8e4', border: '#f5a4d1', text: '#58183f' },
    { bg: '#d4ffe7', border: '#a9f4cb', text: '#1d4a37' },
    { bg: '#ffe5a8', border: '#f4c873', text: '#5f4013' },
    { bg: '#d2dcff', border: '#aabaf5', text: '#23346b' },
    { bg: '#f5cbff', border: '#e29bf2', text: '#4f1660' },
    { bg: '#d1f6ef', border: '#a1e7d9', text: '#1a4538' },
  ];
  const VALID_STATUSES = ['todo', 'in-progress', 'completed'];
  let statusMap = loadStatusMap();
  let manualAssignments = [];
  let dragCardId = null;
  let editModalConfig = null;
  const editModalElements = {
    modal: null,
    form: null,
    idInput: null,
    titleInput: null,
    subjectInput: null,
    dateInput: null,
    timeInput: null,
    notesInput: null,
    statusSelect: null,
    previousOverflow: '',
    previousFocus: null,
  };
  const editModalOverlaySelector = '[data-close-edit]';
  const API_BASE = (window && window.TBP_AUTH_BASE) ? window.TBP_AUTH_BASE.replace(/\/$/, '') : '';
  const ASSIGNMENTS_BASE = (window && window.TBP_ASSIGNMENTS_BASE)
    ? window.TBP_ASSIGNMENTS_BASE.replace(/\/$/, '')
    : API_BASE;

  document.addEventListener('DOMContentLoaded', initDashboard);

  function initDashboard() {
    const lists = Array.from(document.querySelectorAll('.assignment-list'));
  if (!lists.length) return;

  setupManualTaskModal();
  setupEditModal();

  lists.forEach((list) => {
    list.addEventListener('dragover', handleDragOver);
    list.addEventListener('drop', handleDrop);
      list.addEventListener('dragleave', handleDragLeave);
    });

    document.querySelectorAll('.assignment-column').forEach((column) => {
      column.addEventListener('dragover', handleDragOver);
      column.addEventListener('drop', handleDrop);
      column.addEventListener('dragleave', handleDragLeave);
    });

    loadAssignments();
  }

  function setBoardStatus(message, type = 'info') {
    const el = document.querySelector('.assignment-board-status');
    if (!el) return;
    el.textContent = message || '';
    if (message) {
      el.setAttribute('data-status-type', type);
    } else {
      el.removeAttribute('data-status-type');
    }
  }

  function setColumnsLoading(isLoading) {
    document.querySelectorAll('.assignment-column').forEach((column) => {
      column.classList.toggle('is-loading', !!isLoading);
    });
  }

  async function loadAssignments(options = {}) {
    const { successMessage = '' } = options;
    setBoardStatus('Loading assignments…', 'muted');
    setColumnsLoading(true);

    let calendarAssignments = [];
    let errorInfo = null;

    try {
      try {
        calendarAssignments = await fetchAssignmentsFromCalendar();
      } catch (error) {
        errorInfo = error;
        console.error('Assignment dashboard calendar error', error);
      }

      try {
        manualAssignments = await fetchSavedAssignmentsFromApi();
      } catch (manualError) {
        console.error('Assignment dashboard manual sync error', manualError);
        if (!errorInfo) errorInfo = manualError;
        manualAssignments = [];
      }

      const manualEntries = manualAssignments.filter((item) => (item.source || 'manual') === 'manual');
      const overrideEntries = manualAssignments.filter((item) => (item.source || 'manual') !== 'manual');
      const manualObjects = manualEntries.map(convertManualToAssignment).filter(Boolean);
      const overrideMap = new Map();
      overrideEntries.forEach((entry) => {
        const key = entry.icalId || entry.id;
        if (key) overrideMap.set(key, entry);
      });

      const mergedAssignments = mergeAssignments(calendarAssignments, manualObjects, overrideMap);
      const filteredAssignments = filterRecentAssignments(mergedAssignments);

      renderAssignments(filteredAssignments);
      pruneStatusMap(filteredAssignments);

      if (errorInfo) {
        const type = errorInfo.code === 'UNKNOWN' || errorInfo.code === 'NOT_AUTH' ? 'error' : 'muted';
        setBoardStatus(errorInfo.message || 'Unable to load assignments.', type);
      } else if (successMessage) {
        setBoardStatus(successMessage, 'muted');
      } else if (!filteredAssignments.length) {
        setBoardStatus('No assignments found for the next few weeks. New calendar events will appear here automatically.', 'muted');
      } else {
        setBoardStatus('');
      }
    } finally {
      setColumnsLoading(false);
    }
  }

  async function fetchAssignmentsFromCalendar() {
    const token = getToken();
    if (!token) throw createError('NOT_AUTH', 'Log in to view your assignments dashboard.');

    const profile = await fetchDashboardProfile(token);
    const icsUrl = profile && profile.icsUrl ? String(profile.icsUrl).trim() : '';
    if (!icsUrl) {
      throw createError('NO_ICS', 'Add your iCal (.ics) link in Account settings to sync assignments.');
    }

    const base = (window.TBP_AUTH_BASE || '').replace(/\/$/, '');
    if (!base) throw createError('UNKNOWN', 'Calendar service unavailable.');

    const res = await fetch(`${base}/auth/ics?url=${encodeURIComponent(icsUrl)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw createError('UNKNOWN', 'Unable to fetch assignments from your calendar.');
    const text = await res.text();
    const events = parseIcs(text);
    const assignments = transformEvents(events);
    return assignments;
  }

  async function fetchSavedAssignmentsFromApi() {
    const token = getToken();
    if (!token || !ASSIGNMENTS_BASE) return [];
    const res = await fetch(`${ASSIGNMENTS_BASE}/assignments`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) return [];
    if (res.status === 404) return [];
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw createError('MANUAL_FETCH_FAILED', detail && detail.error ? String(detail.error) : 'Unable to load saved assignments.');
    }
    const data = await res.json().catch(() => ({}));
    const list = Array.isArray(data.assignments) ? data.assignments : [];
    const normalized = list.map(normalizeManualAssignment).filter(Boolean);
    let changed = false;
    Object.keys(statusMap).forEach((key) => {
      if (key && key.startsWith('manual-')) {
        delete statusMap[key];
        changed = true;
      }
    });
    normalized.forEach((entry) => {
      if (entry.icalId && statusMap[entry.icalId]) {
        delete statusMap[entry.icalId];
        changed = true;
      }
    });
    if (changed) saveStatusMap();
    return normalized;
  }

  function transformEvents(events) {
    const now = new Date();
    const pastWindow = new Date(now);
    pastWindow.setDate(pastWindow.getDate() - 2);
    const futureWindow = new Date(now);
    futureWindow.setDate(futureWindow.getDate() + 7);

    const relevant = (events || []).filter((ev) => {
      if (!ev.start) return false;
      return ev.start >= pastWindow && ev.start <= futureWindow;
    });

    const assignments = relevant.map((event) => {
      const { mainTitle, subjectLabel: derivedSubjectLabel } = extractTitleAndSubject(event);
      const id = event.uid || `${event.title || 'assignment'}_${event.start ? event.start.toISOString() : ''}`;
      const storedStatus = statusMap[id];
      const summarySubject = extractSubjectFromSummary(event.summary);
      const subjectLabel = summarySubject || derivedSubjectLabel;
      const subjectInfo = deriveSubjectAndTitle(event.title, event.description, subjectLabel);
      const dueLabel = formatDueLabel(event.start);
      const timeLabel = formatTimeLabel(event);
      const description = buildDescriptionSnippet(event.description);
      const status = storedStatus || 'todo';
      const priority = determinePriority(event.start, status);

      return {
        id,
        icalId: id,
        title: mainTitle || subjectInfo.title,
        subject: subjectLabel || subjectInfo.subject,
        due: event.start,
        dueLabel,
        timeLabel,
        description,
        details: description,
        status,
        priority,
        url: event.url || '',
        source: 'ical',
        allDay: !!event.allDay,
      };
    });

    assignments.sort((a, b) => {
      const aTime = a.due ? a.due.getTime() : 0;
      const bTime = b.due ? b.due.getTime() : 0;
      return aTime - bTime;
    });

    return assignments;
  }

  function renderAssignments(assignments) {
    const groups = {
      todo: [],
      'in-progress': [],
      completed: [],
    };

    assignments.forEach((assignment) => {
      if (!groups[assignment.status]) {
        groups[assignment.status] = [];
      }
      groups[assignment.status].push(assignment);
    });

    document.querySelectorAll('.assignment-list').forEach((list) => {
      const status = list.getAttribute('data-status');
      list.innerHTML = '';
      (groups[status] || []).forEach((assignment) => {
        const card = createAssignmentCard(assignment);
        list.appendChild(card);
      });
    });

    updateEmptyStates();
  }

  function mergeAssignments(calendarAssignments, manualAssignmentsList, overrideMap = new Map()) {
    const combined = [];
    const unique = new Map();

    const getKey = (assignment) => assignment && (assignment.icalId || assignment.id);

    const addToMap = (assignment) => {
      if (!assignment) return;
      const key = getKey(assignment);
      if (!key) return;
      unique.set(key, assignment);
    };

    (calendarAssignments || []).forEach((assignment) => {
      if (!assignment) return;
      const key = assignment.icalId || assignment.id;
      const override = overrideMap.get(key);
      if (override) {
        const merged = applyOverrideToAssignment(assignment, override);
        addToMap(merged);
      } else {
        addToMap(assignment);
      }
    });

    (manualAssignmentsList || []).forEach(addToMap);

    unique.forEach((value) => combined.push(value));

    combined.sort((a, b) => {
      const aTime = a.due ? new Date(a.due).getTime() : Number.POSITIVE_INFINITY;
      const bTime = b.due ? new Date(b.due).getTime() : Number.POSITIVE_INFINITY;
      if (aTime !== bTime) return aTime - bTime;
      const aTitle = (a.title || '').toLowerCase();
      const bTitle = (b.title || '').toLowerCase();
      if (aTitle < bTitle) return -1;
      if (aTitle > bTitle) return 1;
      return 0;
    });
    return combined;
  }

  function applyOverrideToAssignment(baseAssignment, override) {
    const merged = { ...baseAssignment };
    merged.icalId = override.icalId || merged.icalId || merged.id;
    if (override.title) merged.title = override.title;
    if (override.subject) merged.subject = override.subject;

    const overrideDue = override.due ? new Date(override.due) : null;
    if (overrideDue && !Number.isNaN(overrideDue.getTime())) {
      merged.due = overrideDue;
      merged.dueLabel = formatDueLabel(overrideDue);
    }

    if (override.status) merged.status = override.status;
    if (override.timeLabel !== undefined) {
      merged.timeLabel = override.timeLabel || '';
    }
    if (override.details !== undefined) {
      merged.description = override.details || '';
      merged.details = override.details || '';
    }
    if (override.allDay !== undefined) merged.allDay = !!override.allDay;
    merged.source = override.source || 'override';
    if (!merged.details) merged.details = merged.description || '';
    return merged;
  }

  function filterRecentAssignments(assignments) {
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    const futureCutoff = new Date(cutoff);
    futureCutoff.setDate(futureCutoff.getDate() + 7);
    return (assignments || []).filter((assignment) => {
      if (!assignment || !assignment.due) return true;
      const dueDate = new Date(assignment.due);
      dueDate.setHours(0, 0, 0, 0);
      return dueDate >= cutoff && dueDate <= futureCutoff;
    });
  }

  function formatDateInputValue(value) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function formatTimeInputValue(value, allDay) {
    if (!value || allDay) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  function normalizeManualAssignment(entry) {
    if (!entry) return null;
    const rawId = entry.id || entry._id;
    if (!rawId) return null;
    const id = rawId.toString();
    const dueSource = entry.dueDate || entry.due || null;
    let dueIso = null;
    if (dueSource instanceof Date) {
      dueIso = dueSource.toISOString();
    } else if (typeof dueSource === 'string' && dueSource.trim()) {
      const parsed = new Date(dueSource);
      if (!Number.isNaN(parsed.getTime())) dueIso = parsed.toISOString();
    }
    return {
      id,
      title: entry.title || '',
      subject: entry.subject || '',
      details: entry.details || entry.description || '',
      due: dueIso,
      status: VALID_STATUSES.includes(entry.status) ? entry.status : 'todo',
      allDay: entry.allDay !== undefined ? !!entry.allDay : true,
      timeLabel: entry.timeLabel || '',
      url: entry.url || '',
      createdAt: entry.createdAt || null,
      updatedAt: entry.updatedAt || null,
      source: entry.source || 'manual',
      icalId: entry.icalId || null,
    };
  }

  function convertManualToAssignment(entry) {
    if (!entry || !entry.id) return null;
    const due = entry.due ? new Date(entry.due) : null;
    const status = VALID_STATUSES.includes(entry.status) ? entry.status : 'todo';
    const firstLine = getFirstLine(entry.details || entry.description || '');
    const mainTitle = entry.title && entry.title.trim() ? entry.title.trim() : firstLine;
    let subject = entry.subject && entry.subject.trim() ? entry.subject.trim() : '';
    if (!subject) {
      subject = extractSubjectFromSummary(entry.title || '') || guessSubjectFromKeywords(mainTitle || '', entry.details || entry.description || '') || 'Assignment';
    }
    const priority = determinePriority(due, status);
    return {
      id: entry.id,
      icalId: entry.icalId || entry.id,
      title: mainTitle || 'Untitled task',
      subject,
      due,
      dueLabel: formatDueLabel(due),
      timeLabel: entry.timeLabel || '',
      description: entry.details || entry.description || '',
      details: entry.details || entry.description || '',
      status,
      priority,
      url: entry.url || '',
      source: entry.source || 'manual',
      allDay: entry.allDay !== undefined ? !!entry.allDay : !entry.timeLabel,
    };
  }

  function pruneStatusMap(assignments) {
    const validSet = new Set();
    (assignments || []).forEach((assignment) => {
      if (!assignment) return;
      if (assignment.id) validSet.add(assignment.id);
      if (assignment.icalId) validSet.add(assignment.icalId);
    });
    let changed = false;
    Object.keys(statusMap).forEach((storedId) => {
      if (!validSet.has(storedId)) {
        delete statusMap[storedId];
        changed = true;
      }
    });
    if (changed) saveStatusMap();
  }

  function updateEmptyStates() {
    document.querySelectorAll('.assignment-column').forEach((column) => {
      const list = column.querySelector('.assignment-list');
      const empty = column.querySelector('.assignment-empty');
      if (!list || !empty) return;
      if (list.children.length === 0) {
        empty.classList.add('visible');
      } else {
        empty.classList.remove('visible');
      }
    });
  }

  function createAssignmentCard(assignment) {
    const card = document.createElement('article');
    card.className = `assignment-card priority-${assignment.priority}`;
    card.setAttribute('draggable', 'true');
    card.dataset.assignmentId = assignment.id;
    card.dataset.source = assignment.source || 'ical';
    if (assignment.icalId) card.dataset.icalId = assignment.icalId;
    card.__assignmentData = { ...assignment };
    card.__assignmentData.icalId = assignment.icalId || assignment.id;
    card.dataset.source = assignment.source || 'ical';
    card.dataset.status = assignment.status;

    card.addEventListener('dragstart', handleDragStart);
    card.addEventListener('dragend', handleDragEnd);

    const header = document.createElement('header');
    const title = document.createElement('h3');
    title.textContent = assignment.title || 'Upcoming assignment';
    header.appendChild(title);
    card.appendChild(header);

    const pillRow = document.createElement('div');
    pillRow.className = 'assignment-pill-row';

    const subjectPill = document.createElement('span');
    subjectPill.className = 'assignment-subject-pill';
    const subjectLabel = (assignment.subject || 'Assignment').toString().trim() || 'Assignment';
    subjectPill.textContent = subjectLabel;
    applySubjectTheme(subjectPill, subjectLabel);
    const subjectClass = subjectToClass(assignment.subject);
    if (subjectClass) subjectPill.classList.add(subjectClass);

    const priorityPill = document.createElement('span');
    priorityPill.className = `assignment-priority-pill priority-${assignment.priority}`;
    priorityPill.textContent = assignment.priority.charAt(0).toUpperCase() + assignment.priority.slice(1);

    pillRow.appendChild(subjectPill);
    pillRow.appendChild(priorityPill);
    card.appendChild(pillRow);

    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'assignment-edit-icon';
    editButton.setAttribute('aria-label', 'Edit assignment');
    editButton.innerHTML = '<i class="bi bi-pencil-fill" aria-hidden="true"></i>';
    editButton.addEventListener('mousedown', (event) => {
      event.stopPropagation();
    });
    editButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openEditModal(card.__assignmentData || assignment);
    });
    card.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openEditModal(card.__assignmentData || assignment);
    });
    card.dataset.editable = 'true';
    card.appendChild(editButton);

    const footer = document.createElement('footer');

    if (assignment.dueLabel) {
      const dueSpan = document.createElement('span');
      const dueIcon = document.createElement('i');
      dueIcon.className = 'bi bi-calendar3';
      dueSpan.appendChild(dueIcon);
      const dueText = document.createTextNode(` Due ${assignment.dueLabel}`);
      dueSpan.appendChild(dueText);
      footer.appendChild(dueSpan);
    }

    card.appendChild(footer);
    return card;
  }

  function applySubjectTheme(element, subject) {
    const theme = getSubjectTheme(subject);
    if (!theme) return;
    element.style.setProperty('--subject-pill-bg', theme.bg);
    element.style.setProperty('--subject-pill-border', theme.border);
    element.style.setProperty('--subject-pill-text', theme.text);
  }

  function getSubjectTheme(subject) {
    const palette = SUBJECT_COLOR_PALETTE;
    if (!palette || !palette.length) return null;
    const key = normalizeSubjectKey(subject);
    const index = hashSubjectKey(key) % palette.length;
    return palette[index];
  }

  function normalizeSubjectKey(subject) {
    return String(subject || 'assignment').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function hashSubjectKey(key) {
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) {
      hash = (hash << 5) - hash + key.charCodeAt(i);
      hash |= 0; // convert to 32-bit int
    }
    return Math.abs(hash);
  }

  function subjectToClass(subjectLabel) {
    if (!subjectLabel) return '';
    const slug = subjectLabel
      .toLowerCase()
      .replace(/ap\s+/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    if (!slug) return '';
    return `subject-${slug}`;
  }

  function handleDragStart(event) {
    const card = event.currentTarget;
    dragCardId = card.dataset.assignmentId;
    event.dataTransfer.effectAllowed = 'move';
    try {
      event.dataTransfer.setData('text/plain', dragCardId);
    } catch (_) {
      /* ignore */
    }
    card.classList.add('dragging');
  }

  function handleDragEnd(event) {
    const card = event.currentTarget;
    card.classList.remove('dragging');
    dragCardId = null;
    document.querySelectorAll('.assignment-column.drag-over').forEach((col) => col.classList.remove('drag-over'));
    updateEmptyStates();
  }

  function handleDragOver(event) {
    event.preventDefault();
    const target = event.target;
    const column = target.closest('.assignment-column');
    const list = column ? column.querySelector('.assignment-list') : null;
    if (column) column.classList.add('drag-over');

    if (!list) return;

    const draggingCard = document.querySelector('.assignment-card.dragging');
    if (!draggingCard) return;

    const afterElement = getDragAfterElement(list, event.clientY);
    if (afterElement == null) {
      list.appendChild(draggingCard);
    } else {
      list.insertBefore(draggingCard, afterElement);
    }
  }

  async function handleDrop(event) {
    event.preventDefault();
    const target = event.target;
    const column = target.closest('.assignment-column');
    const list = column ? column.querySelector('.assignment-list') : null;
    if (!column || !list) return;
    column.classList.remove('drag-over');

    const status = list.getAttribute('data-status') || 'todo';
    let cardId = dragCardId;
    if (!cardId) {
      try {
        cardId = event.dataTransfer.getData('text/plain');
      } catch (_) {
        cardId = null;
      }
    }
    if (!cardId) return;

    const card = list.querySelector(`.assignment-card[data-assignment-id="${cardId}"]`) ||
      document.querySelector(`.assignment-card[data-assignment-id="${cardId}"]`);
    if (!card) return;

    card.dataset.status = status;
    const source = card.dataset.source || 'ical';
    const assignmentData = card.__assignmentData || manualAssignments.find((item) => item.id === cardId || item.icalId === cardId) || null;
    if (source === 'manual') {
      try {
        await updateManualAssignmentStatus(cardId, status);
        if (assignmentData) assignmentData.status = status;
        if (card.__assignmentData) card.__assignmentData.status = status;
        dragCardId = null;
        updateEmptyStates();
        setBoardStatus('Assignment updated.', 'muted');
      } catch (error) {
        console.error('Manual assignment update error', error);
        setBoardStatus('Unable to update assignment status. Please try again.', 'error');
        dragCardId = null;
        await loadAssignments();
      }
      return;
    }

    try {
      await updateCalendarAssignmentStatus(assignmentData || { id: cardId, icalId: card.dataset.icalId || cardId, title: card.querySelector('h3') ? card.querySelector('h3').textContent : '' }, status);
      dragCardId = null;
      await loadAssignments({ successMessage: 'Assignment updated.' });
    } catch (error) {
      console.error('Calendar assignment update error', error);
      setBoardStatus('Unable to update assignment status. Please try again.', 'error');
      dragCardId = null;
      await loadAssignments();
    }
  }

  function handleDragLeave(event) {
    const column = event.target.closest('.assignment-column');
    if (!column) return;
    const list = column.querySelector('.assignment-list');
    if (!list) return;
    const rect = list.getBoundingClientRect();
    const withinY = event.clientY >= rect.top && event.clientY <= rect.bottom;
    const withinX = event.clientX >= rect.left && event.clientX <= rect.right;
    if (!withinX || !withinY) {
      column.classList.remove('drag-over');
    }
  }

  function getDragAfterElement(container, y) {
    const elements = [...container.querySelectorAll('.assignment-card:not(.dragging)')];
    return elements.reduce(
      (closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
          return { offset, element: child };
        }
        return closest;
      },
      { offset: Number.NEGATIVE_INFINITY, element: null }
    ).element;
  }

  async function updateManualAssignmentStatus(id, status) {
    if (!id) return;
    const idx = manualAssignments.findIndex((item) => item.id === id);
    if (idx === -1) return;
    const previous = manualAssignments[idx].status;
    manualAssignments[idx].status = status;
    manualAssignments[idx].updatedAt = new Date().toISOString();
    const token = getToken();
    if (!token || !ASSIGNMENTS_BASE) return;
    try {
      const res = await fetch(`${ASSIGNMENTS_BASE}/assignments/${id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw createError('MANUAL_UPDATE_FAILED', detail && detail.error ? String(detail.error) : 'Unable to update assignment.');
      }
      const data = await res.json().catch(() => ({}));
      if (data.assignment) {
        const normalized = normalizeManualAssignment(data.assignment);
        if (normalized) manualAssignments[idx] = normalized;
      }
    } catch (error) {
      manualAssignments[idx].status = previous;
      manualAssignments[idx].updatedAt = new Date().toISOString();
      throw error;
    }
  }

  function deriveSubjectAndTitle(summary, description) {
    const cleanSummary = (summary || '').trim();
    const cleanDescription = (description || '').trim();
    const keywordSubject = guessSubjectFromKeywords(cleanSummary, cleanDescription);

    if (!cleanSummary) {
      return { subject: 'Assignment', title: cleanDescription.split(/\n/)[0] || 'Untitled task' };
    }
    const separators = [' – ', ' — ', ' - ', ': '];
    for (const sep of separators) {
      if (cleanSummary.includes(sep)) {
        const parts = cleanSummary.split(sep);
        if (parts.length >= 2) {
          const subjectCandidate = parts[0].trim();
          const titleCandidate = parts.slice(1).join(sep).trim();
          if (subjectCandidate && subjectCandidate.length <= 48) {
            return {
              subject: keywordSubject || subjectCandidate,
              title: titleCandidate || subjectCandidate,
            };
          }
        }
      }
    }

    const subjectLine = cleanDescription
      .split(/\n/)
      .map((line) => line.trim())
      .find((line) => /^subject:/i.test(line));
    if (subjectLine) {
      const subjectText = subjectLine.split(':').slice(1).join(':').trim();
      if (subjectText) {
        return { subject: keywordSubject || subjectText, title: cleanSummary };
      }
    }

    const words = cleanSummary.split(' ');
    if (words.length <= 4) {
      return { subject: keywordSubject || cleanSummary, title: cleanSummary };
    }

    return { subject: keywordSubject || words.slice(0, 3).join(' '), title: cleanSummary };
  }

  function extractTitleAndSubject(event) {
    const description = event.description || '';
    const firstLine = getFirstLine(description);
    const subjectLineMatch = /^\s*subject\s*:\s*(.+)$/gim;
    let subjectLabel = '';
    let match;
    while ((match = subjectLineMatch.exec(description))) {
      if (match && match[1]) {
        subjectLabel = match[1].trim();
        break;
      }
    }
    const rawSummary = (event.summary || '').trim();
    const cleanedSummary = cleanSummaryTitle(rawSummary);
    const mainTitle = cleanedSummary || rawSummary || firstLine;
    return { mainTitle, subjectLabel };
  }

  function getFirstLine(text) {
    if (!text) return '';
    const first = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return first || '';
  }

  function cleanSummaryTitle(text) {
    if (!text) return '';
    return text
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function guessSubjectFromKeywords(summary, description) {
    const haystack = `${summary || ''} ${description || ''}`.toLowerCase();
    if (!haystack.trim()) return '';
    for (const item of SUBJECT_KEYWORDS) {
      if (item.match.some((keyword) => haystack.includes(keyword))) {
        return item.label;
      }
    }
    return '';
  }

  function extractSubjectFromSummary(summary) {
    if (!summary) return '';
    const match = summary.match(/\[([^\]]+)\]\s*$/);
    if (match && match[1]) {
      return match[1].trim();
    }
    return '';
  }

  function formatDueLabel(date) {
    if (!date) return '';
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      weekday: 'long',
    }).format(date);
    const month = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      month: 'short',
    }).format(date);
    const dayNumber = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE,
        day: 'numeric',
      }).format(date)
    );
    const year = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      year: 'numeric',
    }).format(date);
    const suffix = getOrdinalSuffix(dayNumber);
    return `${weekday}, ${month} ${dayNumber}${suffix}, ${year}`;
  }

  function getOrdinalSuffix(day) {
    const remainderTen = day % 10;
    const remainderHundred = day % 100;
    if (remainderHundred >= 11 && remainderHundred <= 13) return 'th';
    if (remainderTen === 1) return 'st';
    if (remainderTen === 2) return 'nd';
    if (remainderTen === 3) return 'rd';
    return 'th';
  }

  function formatTimeLabel(event) {
    if (!event.start) return '';
    if (event.allDay) return 'All day';
    const timeFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      hour: 'numeric',
      minute: '2-digit',
    });
    const startStr = timeFmt.format(event.start);
    if (!event.end || event.end.getTime() === event.start.getTime()) {
      return `${startStr} ${TIMEZONE_LABEL}`;
    }
    const endStr = timeFmt.format(event.end);
    return `${startStr} – ${endStr} ${TIMEZONE_LABEL}`;
  }

  function buildDescriptionSnippet(description) {
    if (!description) return '';
    const clean = description
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ');
    if (!clean) return '';
    if (clean.length <= 160) return clean;
    return `${clean.slice(0, 157)}…`;
  }

  function determinePriority(dueDate, status) {
    if (!dueDate) return 'low';
    if (status === 'completed') return 'low';
    const now = new Date();
    const diffMs = dueDate.getTime() - now.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    if (diffDays <= 2) return 'high';
    if (diffDays <= 5) return 'medium';
    return 'low';
  }

  function setupManualTaskModal() {
    const modal = document.getElementById('assignmentModal');
    const openBtn = document.querySelector('.assignment-add-btn');
    const form = document.getElementById('assignmentForm');
    if (!modal || !openBtn || !form) return;

    const closeElements = modal.querySelectorAll('[data-close-modal]');
    const titleField = form.querySelector('#assignmentTitle');
    if (titleField) {
      titleField.addEventListener('input', () => {
        titleField.removeAttribute('aria-invalid');
        titleField.setCustomValidity && titleField.setCustomValidity('');
      });
    }
    let previousFocus = null;
    let previousOverflow = '';

    function openModal() {
      previousFocus = document.activeElement;
      previousOverflow = document.body.style.overflow;
      modal.classList.add('active');
      modal.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      if (titleField) {
        titleField.removeAttribute('aria-invalid');
        titleField.setCustomValidity && titleField.setCustomValidity('');
        setTimeout(() => titleField.focus(), 0);
      }
    }

    function closeModal() {
      modal.classList.remove('active');
      modal.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = previousOverflow || '';
      form.reset();
      if (titleField) {
        titleField.removeAttribute('aria-invalid');
        titleField.setCustomValidity && titleField.setCustomValidity('');
      }
      if (previousFocus && typeof previousFocus.focus === 'function') {
        previousFocus.focus();
      }
      previousOverflow = '';
      previousFocus = null;
    }

    openBtn.addEventListener('click', () => {
      form.reset();
      openModal();
    });

    closeElements.forEach((el) => {
      el.addEventListener('click', closeModal);
    });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal.classList.contains('active')) {
      closeModal();
    }
  });

  form.addEventListener('submit', async (event) => {
      event.preventDefault();

      if (!form.reportValidity()) {
        return;
      }

      const formData = new FormData(form);
      const rawTitle = (formData.get('title') || '').toString();
      const title = rawTitle.trim();
      if (!title) {
        if (titleField) {
          titleField.value = '';
          titleField.setCustomValidity && titleField.setCustomValidity('Please enter a task name.');
          titleField.reportValidity();
          titleField.setCustomValidity && titleField.setCustomValidity('');
          titleField.setAttribute('aria-invalid', 'true');
          titleField.focus();
        }
        return;
      }

      if (titleField) {
        titleField.value = title;
        titleField.removeAttribute('aria-invalid');
      }

      const subject = (formData.get('subject') || '').toString().trim();
      const dueDate = (formData.get('dueDate') || '').toString();
      const dueTime = (formData.get('dueTime') || '').toString();
      const details = (formData.get('details') || '').toString().trim();

      try {
        await createManualAssignment({ title, subject, dueDate, dueTime, details });
        closeModal();
        loadAssignments({ successMessage: 'Task added to To Do.' });
      } catch (error) {
        console.error('Manual assignment create error', error);
        setBoardStatus('Unable to save assignment. Please try again.', 'error');
      }
    });
  }

  function setupEditModal() {
    const modal = document.getElementById('assignmentEditModal');
    const form = document.getElementById('assignmentEditForm');
    if (!modal || !form) return;
    editModalElements.modal = modal;
    editModalElements.form = form;
    editModalElements.idInput = document.getElementById('assignmentEditId');
    editModalElements.titleInput = document.getElementById('assignmentEditTitleInput');
    editModalElements.subjectInput = document.getElementById('assignmentEditSubject');
    editModalElements.dateInput = document.getElementById('assignmentEditDate');
    editModalElements.timeInput = document.getElementById('assignmentEditTime');
    editModalElements.notesInput = document.getElementById('assignmentEditNotes');
    editModalElements.statusSelect = document.getElementById('assignmentEditStatus');
    editModalElements.submitButton = form.querySelector('button[type="submit"]');
    editModalElements.info = document.getElementById('assignmentEditInfo');

    modal.querySelectorAll(editModalOverlaySelector).forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        closeEditModal();
      });
    });

    form.addEventListener('submit', handleEditSubmit);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && editModalElements.modal && editModalElements.modal.classList.contains('active')) {
        closeEditModal();
      }
    });
  }

  async function createManualAssignment({ title, subject, dueDate, dueTime, details }) {
    const token = getToken();
    if (!token || !ASSIGNMENTS_BASE) throw createError('NOT_AUTH', 'Log in to add assignments.');

    let dueIso = null;
    let allDay = true;
    if (dueDate) {
      const isoCandidate = dueTime ? `${dueDate}T${dueTime}` : `${dueDate}T12:00:00`;
      const parsed = new Date(isoCandidate);
      if (!Number.isNaN(parsed.getTime())) {
        dueIso = parsed.toISOString();
        allDay = !dueTime;
      }
    }

    const payload = {
      title,
      subject,
      dueDate: dueIso,
      status: 'todo',
      details,
      allDay,
      timeLabel: dueTime || '',
    };

    const res = await fetch(`${ASSIGNMENTS_BASE}/assignments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw createError('MANUAL_CREATE_FAILED', detail && detail.error ? String(detail.error) : 'Unable to create assignment.');
    }

    const data = await res.json().catch(() => ({}));
    if (data && data.assignment) {
      const normalized = normalizeManualAssignment(data.assignment);
      if (normalized) manualAssignments.push(normalized);
    }
  }

  async function saveCalendarOverride({ icalId, title, subject, status, dueIso, details, allDay, timeLabel }) {
    const token = getToken();
    if (!token || !ASSIGNMENTS_BASE) throw createError('NOT_AUTH', 'Log in to update assignments.');
    const payload = {
      title,
      subject,
      status: VALID_STATUSES.includes(status) ? status : 'todo',
      dueDate: dueIso,
      details,
      allDay,
      timeLabel,
    };
    const res = await fetch(`${ASSIGNMENTS_BASE}/assignments/ical/${encodeURIComponent(icalId)}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw createError('MANUAL_UPDATE_FAILED', detail && detail.error ? String(detail.error) : 'Unable to update assignment.');
    }
    const data = await res.json().catch(() => ({}));
    if (data && data.assignment) {
      const normalized = normalizeManualAssignment(data.assignment);
      if (normalized) {
        const idx = manualAssignments.findIndex((item) => item.id === normalized.id || (item.icalId && normalized.icalId && item.icalId === normalized.icalId));
        if (idx !== -1) {
          manualAssignments[idx] = normalized;
        } else {
          manualAssignments.push(normalized);
        }
        const key = normalized.icalId || normalized.id;
        if (key && statusMap[key]) {
          delete statusMap[key];
          saveStatusMap();
        }
        return normalized;
      }
    }
    return null;
  }

  async function updateCalendarAssignmentStatus(assignment, status) {
    const icalId = assignment.icalId || assignment.id;
    if (!icalId) return;
    const dueIso = assignment.due ? new Date(assignment.due).toISOString() : null;
    const allDay = assignment.allDay !== undefined ? !!assignment.allDay : !assignment.timeLabel;
    const details = assignment.details || assignment.description || '';
    const timeLabel = assignment.timeLabel || '';
    const saved = await saveCalendarOverride({
      icalId,
      title: assignment.title || '',
      subject: assignment.subject || '',
      status,
      dueIso,
      details,
      allDay,
      timeLabel,
    });
    if (saved) {
      assignment.status = saved.status || status;
      assignment.allDay = saved.allDay !== undefined ? saved.allDay : allDay;
      assignment.timeLabel = saved.timeLabel || timeLabel;
      if (saved.due) {
        const dueUpdate = new Date(saved.due);
        if (!Number.isNaN(dueUpdate.getTime())) {
          assignment.due = dueUpdate;
          assignment.dueLabel = formatDueLabel(dueUpdate);
        }
      }
      assignment.details = saved.details || details;
      assignment.description = saved.details || details;
      assignment.source = saved.source || 'override';
      assignment.icalId = saved.icalId || icalId;
    }
    const key = assignment.icalId || assignment.id;
    if (key) {
      statusMap[key] = assignment.status || status;
      saveStatusMap();
    }
  }

  async function handleEditSubmit(event) {
    event.preventDefault();
    if (!editModalElements.form || !editModalConfig || !editModalElements.titleInput) return;
    const form = editModalElements.form;
    if (!form.reportValidity()) return;

    const { id, source, icalId } = editModalConfig;
    const title = editModalElements.titleInput ? editModalElements.titleInput.value.trim() : '';
    const subject = editModalElements.subjectInput ? editModalElements.subjectInput.value.trim() : '';
    const dueDateValue = editModalElements.dateInput ? editModalElements.dateInput.value : '';
    const dueTimeValue = editModalElements.timeInput ? editModalElements.timeInput.value : '';
    const details = editModalElements.notesInput ? editModalElements.notesInput.value.trim() : '';
    const statusSelect = editModalElements.statusSelect;
    const statusValue = statusSelect && VALID_STATUSES.includes(statusSelect.value)
      ? statusSelect.value
      : 'todo';

    const token = getToken();
    if (!token || !ASSIGNMENTS_BASE) {
      setBoardStatus('Log in to update assignments.', 'error');
      return;
    }

    const payload = { title, subject, status: statusValue, details };
    let dueIso = null;
    let allDay = true;
    if (dueDateValue) {
      const isoCandidate = dueTimeValue ? `${dueDateValue}T${dueTimeValue}` : `${dueDateValue}T12:00:00`;
      const parsed = new Date(isoCandidate);
      if (!Number.isNaN(parsed.getTime())) {
        dueIso = parsed.toISOString();
        allDay = !dueTimeValue;
      }
    }

    payload.dueDate = dueIso;
    payload.allDay = allDay;
      payload.timeLabel = dueTimeValue || '';

    try {
      if (source === 'manual') {
        const res = await fetch(`${ASSIGNMENTS_BASE}/assignments/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const detail = await res.json().catch(() => ({}));
          throw createError('MANUAL_UPDATE_FAILED', detail && detail.error ? String(detail.error) : 'Unable to update assignment.');
        }
        const data = await res.json().catch(() => ({}));
        if (data && data.assignment) {
          const normalized = normalizeManualAssignment(data.assignment);
          if (normalized) {
            const idx = manualAssignments.findIndex((item) => item.id === normalized.id);
            if (idx !== -1) {
              manualAssignments[idx] = normalized;
            }
          }
        }
      } else {
        await saveCalendarOverride({
          icalId: icalId || id,
          title,
          subject,
          status: statusValue,
          dueIso,
          details,
          allDay,
          timeLabel: dueTimeValue || '',
        });
      }
      closeEditModal();
      loadAssignments({ successMessage: 'Assignment updated.' });
    } catch (error) {
      console.error('Manual assignment edit error', error);
      setBoardStatus(error.message || 'Unable to update assignment. Please try again.', 'error');
    }
  }

  function openEditModal(assignment) {
    if (!assignment || !editModalElements.modal) return;
    const source = assignment.source || 'ical';
    const icalKey = assignment.icalId || assignment.id;
    const overrideData = manualAssignments.find((item) => item.icalId && item.icalId === icalKey);

    const record = (() => {
      if (source === 'manual') {
        return manualAssignments.find((item) => item.id === assignment.id) || assignment;
      }
      if (overrideData) {
        const dueOverride = overrideData.due ? new Date(overrideData.due) : null;
        return {
          ...assignment,
          ...overrideData,
          id: overrideData.id,
          source: overrideData.source || 'override',
          due: dueOverride && !Number.isNaN(dueOverride.getTime()) ? dueOverride : assignment.due,
          timeLabel: overrideData.timeLabel || assignment.timeLabel || '',
          status: overrideData.status || assignment.status,
          details: overrideData.details || overrideData.description || assignment.description || '',
          description: overrideData.details || overrideData.description || assignment.description || '',
        };
      }
      return {
        ...assignment,
        source: assignment.source || 'ical',
        details: assignment.description || '',
      };
    })();

    if (!record) return;

    const normalizedSource = record.source || source;
    editModalConfig = {
      id: record.id,
      source: normalizedSource,
      icalId: record.icalId || icalKey || null,
    };
    const {
      modal,
      idInput,
      titleInput,
      subjectInput,
      dateInput,
      timeInput,
      notesInput,
      statusSelect,
      submitButton,
      info,
    } = editModalElements;

    editModalElements.previousOverflow = document.body.style.overflow || '';
    editModalElements.previousFocus = document.activeElement;

    if (idInput) idInput.value = record.id;
    if (titleInput) titleInput.value = record.title || '';
    if (subjectInput) subjectInput.value = record.subject || '';
    if (dateInput) dateInput.value = formatDateInputValue(record.due);
    if (timeInput) timeInput.value = formatTimeInputValue(record.due, record.allDay);
    if (notesInput) notesInput.value = record.details || record.description || '';
    if (statusSelect) statusSelect.value = VALID_STATUSES.includes(record.status) ? record.status : 'todo';

    [titleInput, subjectInput, dateInput, timeInput, notesInput, statusSelect].forEach((input) => {
      if (input) input.disabled = false;
    });
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.style.display = '';
    }
    if (info) {
      if (normalizedSource === 'manual') {
        info.textContent = '';
        info.classList.remove('show');
      } else {
        info.textContent = 'Updates made here override the calendar event for your dashboard.';
        info.classList.add('show');
      }
    }

    document.body.style.overflow = 'hidden';
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => {
      if (titleInput) titleInput.focus();
    }, 50);
  }

  function closeEditModal() {
    if (!editModalElements.modal) return;
    const {
      modal,
      form,
      titleInput,
      subjectInput,
      dateInput,
      timeInput,
      notesInput,
      statusSelect,
      submitButton,
      info,
    } = editModalElements;
    if (!modal.classList.contains('active')) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    if (form) form.reset();
    [titleInput, subjectInput, dateInput, timeInput, notesInput, statusSelect].forEach((input) => {
      if (input) input.disabled = false;
    });
    if (statusSelect) statusSelect.disabled = false;
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.style.display = '';
    }
    if (info) {
      info.textContent = '';
      info.classList.remove('show');
    }
    document.body.style.overflow = editModalElements.previousOverflow || '';
    const focusTarget = editModalElements.previousFocus;
    if (focusTarget && typeof focusTarget.focus === 'function') {
      focusTarget.focus();
    }
    editModalElements.previousFocus = null;
    editModalElements.previousOverflow = '';
    editModalConfig = null;
  }

  function parseIcs(icsText) {
    const events = [];
    if (!icsText) return events;
    const lines = icsText.split(/\r?\n/);
    const unfolded = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\s/.test(line) && unfolded.length) {
        unfolded[unfolded.length - 1] += line.trim();
      } else {
        unfolded.push(line);
      }
    }

    let cur = null;
    unfolded.forEach((raw) => {
      const line = raw.trim();
      if (line === 'BEGIN:VEVENT') {
        cur = {};
        return;
      }
      if (line === 'END:VEVENT') {
        if (cur) {
          const event = finalizeEvent(cur);
          if (event) events.push(event);
        }
        cur = null;
        return;
      }
      if (!cur) return;
      const idx = line.indexOf(':');
      if (idx < 0) return;
      const keyPart = line.slice(0, idx);
      const val = line.slice(idx + 1);
      const key = keyPart.split(';')[0];
      if (key === 'DTSTART' || key.startsWith('DTSTART')) {
        cur.DTSTART = val;
      } else if (key === 'DTEND' || key.startsWith('DTEND')) {
        cur.DTEND = val;
      } else if (key === 'SUMMARY') {
        cur.SUMMARY = decodeIcsText(val);
      } else if (key === 'DESCRIPTION') {
        cur.DESCRIPTION = decodeIcsText(val);
      } else if (key === 'URL' || key === 'URL;VALUE=URI') {
        cur.URL = val;
      } else if (key === 'UID') {
        cur.UID = val;
      }
    });

    return events;
  }

  function finalizeEvent(raw) {
    if (!raw) return null;
    const start = icsToDate(raw.DTSTART);
    if (!start) return null;
    const end = icsToDate(raw.DTEND || raw.DTSTART);
    const allDay = isAllDayValue(raw.DTSTART);
    return {
      uid: raw.UID || '',
      title: raw.SUMMARY || '',
      summary: raw.SUMMARY || '',
      description: raw.DESCRIPTION || '',
      start,
      end,
      allDay,
      url: raw.URL || '',
    };
  }

  function decodeIcsText(value) {
    return String(value || '')
      .replace(/\\n/g, '\n')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';');
  }

  function icsToDate(value) {
    if (!value) return null;
    if (/^\d{8}$/.test(value)) {
      const y = Number(value.slice(0, 4));
      const m = Number(value.slice(4, 6));
      const d = Number(value.slice(6, 8));
      return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    }
    if (/^\d{8}T\d{6}Z$/.test(value)) {
      const y = Number(value.slice(0, 4));
      const m = Number(value.slice(4, 6));
      const d = Number(value.slice(6, 8));
      const hh = Number(value.slice(9, 11));
      const mm = Number(value.slice(11, 13));
      const ss = Number(value.slice(13, 15));
      return new Date(Date.UTC(y, m - 1, d, hh, mm, ss));
    }
    const dt = new Date(value);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  function isAllDayValue(value) {
    return /^\d{8}$/.test(value || '');
  }

  async function fetchDashboardProfile(token) {
    const base = (window.TBP_AUTH_BASE || '').replace(/\/$/, '');
    if (!base) return null;
    try {
      const res = await fetch(`${base}/auth/profile`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data && data.profile) return data.profile;
      return null;
    } catch (_) {
      return null;
    }
  }

  function getToken() {
    try {
      return localStorage.getItem('tbp_token') || '';
    } catch (_) {
      return '';
    }
  }

  function loadStatusMap() {
    try {
      const raw = localStorage.getItem(STATUS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function saveStatusMap() {
    try {
      const keys = Object.keys(statusMap);
      if (!keys.length) {
        localStorage.removeItem(STATUS_KEY);
      } else {
        localStorage.setItem(STATUS_KEY, JSON.stringify(statusMap));
      }
    } catch (_) {
      /* ignore storage errors */
    }
  }

  function createError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }
})();
