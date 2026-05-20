export type CanvasConfig = {
  host: string;
  token: string;
};

export type CanvasUser = {
  id: number;
  name: string;
  short_name?: string;
  sortable_name?: string;
  email?: string | null;
  primary_email?: string;
  login_id?: string | null;
};

export type CanvasTerm = {
  id: number;
  name: string;
  start_at?: string | null;
  end_at?: string | null;
};

export type CanvasCourseEnrollment = {
  type: string;
  role?: string;
  enrollment_state?: string;
};

export type CanvasCourse = {
  id: number;
  name: string;
  course_code?: string;
  workflow_state: string;
  start_at?: string | null;
  end_at?: string | null;
  term?: CanvasTerm;
  enrollments?: CanvasCourseEnrollment[];
};

export type CanvasAssignment = {
  id: number;
  course_id: number;
  name: string;
  description?: string | null;
  due_at?: string | null;
  points_possible?: number | null;
  submission_types?: string[];
  workflow_state: string; // "published" | "unpublished" | "deleted"
  published?: boolean;
};
