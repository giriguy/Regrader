import { useEffect, useState } from 'react';
import { api, type Assignment, type Course } from '../api';

type Props = {
  courses: Course[];
  selectedAssignmentId: string | null;
  onSelectAssignment: (courseId: string, assignmentId: string) => void;
  onCoursesRefreshed: () => void;
};

const STATUS_COLOR: Record<Assignment['status'], string> = {
  graded: 'text-emerald-700',
  submitted: 'text-amber-700',
  not_submitted: 'text-slate-400',
};

const STATUS_LABEL: Record<Assignment['status'], string> = {
  graded: 'graded',
  submitted: 'submitted',
  not_submitted: 'not submitted',
};

export function CourseTree({
  courses,
  selectedAssignmentId,
  onSelectAssignment,
  onCoursesRefreshed,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [byCourse, setByCourse] = useState<Record<string, Assignment[]>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [syncingCourses, setSyncingCourses] = useState(false);
  const [syncingAssignmentsFor, setSyncingAssignmentsFor] = useState<
    string | null
  >(null);

  const loadAssignments = async (courseId: string) => {
    setLoading((prev) => new Set(prev).add(courseId));
    try {
      const list = await api.listAssignments(courseId);
      setByCourse((prev) => ({ ...prev, [courseId]: list }));
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(courseId);
        return next;
      });
    }
  };

  useEffect(() => {
    if (selectedAssignmentId) {
      // Make sure the course containing the selected assignment is expanded
      // and its assignments are loaded so the user can see context.
      for (const [courseId, list] of Object.entries(byCourse)) {
        if (list.some((a) => a.id === selectedAssignmentId)) {
          setExpanded((prev) => {
            if (prev.has(courseId)) return prev;
            const next = new Set(prev);
            next.add(courseId);
            return next;
          });
          break;
        }
      }
    }
  }, [selectedAssignmentId, byCourse]);

  const toggle = async (courseId: string) => {
    const isExpanding = !expanded.has(courseId);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(courseId)) next.delete(courseId);
      else next.add(courseId);
      return next;
    });
    if (isExpanding && !byCourse[courseId]) {
      await loadAssignments(courseId);
    }
  };

  const syncCourses = async () => {
    setSyncingCourses(true);
    try {
      await api.syncCourses();
      onCoursesRefreshed();
    } finally {
      setSyncingCourses(false);
    }
  };

  const syncAssignments = async (courseId: string) => {
    setSyncingAssignmentsFor(courseId);
    try {
      await api.syncAssignments(courseId);
      await loadAssignments(courseId);
    } finally {
      setSyncingAssignmentsFor(null);
    }
  };

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 p-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Courses
        </h2>
        <button
          onClick={syncCourses}
          disabled={syncingCourses}
          className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          {syncingCourses ? 'Syncing…' : 'Sync courses'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {courses.length === 0 ? (
          <p className="p-4 text-xs text-slate-500">
            No courses yet. Click <strong>Sync courses</strong> to fetch
            them from Gradescope.
          </p>
        ) : (
          courses.map((c) => (
            <div key={c.id}>
              <div className="flex items-center gap-1 px-2">
                <button
                  onClick={() => toggle(c.id)}
                  className="flex flex-1 items-center gap-2 rounded px-1.5 py-1.5 text-left text-sm hover:bg-slate-100"
                >
                  <span
                    className={`inline-block w-3 text-slate-400 transition-transform ${
                      expanded.has(c.id) ? 'rotate-90' : ''
                    }`}
                  >
                    ▶
                  </span>
                  <span className="font-semibold">{c.short_name}</span>
                  {c.full_name && (
                    <span className="truncate text-xs text-slate-500">
                      {c.full_name}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => syncAssignments(c.id)}
                  disabled={syncingAssignmentsFor === c.id}
                  title="Sync this course's assignments"
                  className="rounded px-1.5 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50"
                >
                  {syncingAssignmentsFor === c.id ? '…' : '↻'}
                </button>
              </div>

              {expanded.has(c.id) && (
                <ul className="ml-5 border-l border-slate-200 py-1 pl-1">
                  {loading.has(c.id) && !byCourse[c.id] ? (
                    <li className="px-2 py-1 text-xs text-slate-400">
                      loading…
                    </li>
                  ) : byCourse[c.id]?.length ? (
                    byCourse[c.id].map((a) => (
                      <li key={a.id}>
                        <button
                          onClick={() => onSelectAssignment(c.id, a.id)}
                          className={`block w-full rounded px-2 py-1 text-left text-xs hover:bg-slate-100 ${
                            selectedAssignmentId === a.id
                              ? 'bg-slate-200 font-medium text-slate-900'
                              : 'text-slate-700'
                          }`}
                        >
                          <span className="block truncate">{a.title}</span>
                          <span
                            className={`block text-[10px] ${
                              STATUS_COLOR[a.status]
                            }`}
                          >
                            {STATUS_LABEL[a.status]}
                            {a.score != null && a.max_score != null && (
                              <span className="ml-1 text-slate-500">
                                ({a.score}/{a.max_score})
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    ))
                  ) : (
                    <li className="px-2 py-1 text-xs text-slate-400">
                      no assignments — click ↻ to sync
                    </li>
                  )}
                </ul>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
