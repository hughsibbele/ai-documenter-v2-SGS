export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      admins: {
        Row: {
          active: boolean
          email: string
          granted_at: string
          granted_by_email: string | null
        }
        Insert: {
          active?: boolean
          email: string
          granted_at?: string
          granted_by_email?: string | null
        }
        Update: {
          active?: boolean
          email?: string
          granted_at?: string
          granted_by_email?: string | null
        }
        Relationships: []
      }
      assignment_install_state: {
        Row: {
          canvas_assignment_id: string
          canvas_course_id: string
          created_at: string
          id: string
          iframe_token: string | null
          installed_at: string | null
          last_error: string | null
          prompt_version: number | null
          status: Database["public"]["Enums"]["install_status"]
          teacher_id: string
          uninstalled_at: string | null
          updated_at: string
        }
        Insert: {
          canvas_assignment_id: string
          canvas_course_id: string
          created_at?: string
          id?: string
          iframe_token?: string | null
          installed_at?: string | null
          last_error?: string | null
          prompt_version?: number | null
          status: Database["public"]["Enums"]["install_status"]
          teacher_id: string
          uninstalled_at?: string | null
          updated_at?: string
        }
        Update: {
          canvas_assignment_id?: string
          canvas_course_id?: string
          created_at?: string
          id?: string
          iframe_token?: string | null
          installed_at?: string | null
          last_error?: string | null
          prompt_version?: number | null
          status?: Database["public"]["Enums"]["install_status"]
          teacher_id?: string
          uninstalled_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignment_install_state_teacher_id_fkey"
            columns: ["teacher_id"]
            isOneToOne: false
            referencedRelation: "teachers"
            referencedColumns: ["id"]
          },
        ]
      }
      canvas_assignment_cache: {
        Row: {
          canvas_assignment_id: string
          canvas_course_id: string
          description: string | null
          due_at: string | null
          first_seen_at: string
          last_synced_at: string
          name: string
          points_possible: number | null
          published: boolean | null
          teacher_id: string
          workflow_state: string
        }
        Insert: {
          canvas_assignment_id: string
          canvas_course_id: string
          description?: string | null
          due_at?: string | null
          first_seen_at?: string
          last_synced_at?: string
          name: string
          points_possible?: number | null
          published?: boolean | null
          teacher_id: string
          workflow_state: string
        }
        Update: {
          canvas_assignment_id?: string
          canvas_course_id?: string
          description?: string | null
          due_at?: string | null
          first_seen_at?: string
          last_synced_at?: string
          name?: string
          points_possible?: number | null
          published?: boolean | null
          teacher_id?: string
          workflow_state?: string
        }
        Relationships: [
          {
            foreignKeyName: "canvas_assignment_cache_teacher_id_fkey"
            columns: ["teacher_id"]
            isOneToOne: false
            referencedRelation: "teachers"
            referencedColumns: ["id"]
          },
        ]
      }
      canvas_course_cache: {
        Row: {
          canvas_course_id: string
          course_code: string | null
          end_at: string | null
          last_synced_at: string
          name: string
          start_at: string | null
          teacher_id: string
          term_end_at: string | null
          term_name: string | null
          term_start_at: string | null
          workflow_state: string
        }
        Insert: {
          canvas_course_id: string
          course_code?: string | null
          end_at?: string | null
          last_synced_at?: string
          name: string
          start_at?: string | null
          teacher_id: string
          term_end_at?: string | null
          term_name?: string | null
          term_start_at?: string | null
          workflow_state: string
        }
        Update: {
          canvas_course_id?: string
          course_code?: string | null
          end_at?: string | null
          last_synced_at?: string
          name?: string
          start_at?: string | null
          teacher_id?: string
          term_end_at?: string | null
          term_name?: string | null
          term_start_at?: string | null
          workflow_state?: string
        }
        Relationships: [
          {
            foreignKeyName: "canvas_course_cache_teacher_id_fkey"
            columns: ["teacher_id"]
            isOneToOne: false
            referencedRelation: "teachers"
            referencedColumns: ["id"]
          },
        ]
      }
      card_text_defaults: {
        Row: {
          body: string
          cta_label: string
          footnote: string
          id: number
          kicker: string
          title: string
          updated_at: string
        }
        Insert: {
          body?: string
          cta_label?: string
          footnote?: string
          id: number
          kicker?: string
          title?: string
          updated_at?: string
        }
        Update: {
          body?: string
          cta_label?: string
          footnote?: string
          id?: number
          kicker?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      course_install_policies: {
        Row: {
          auto_install_enabled_at: string | null
          auto_install_new_assignments: boolean
          canvas_course_id: string
          created_at: string
          default_allowed_tools: string[]
          default_prompt_id: string
          id: string
          last_synced_at: string | null
          prompt_version: number
          teacher_id: string
          updated_at: string
        }
        Insert: {
          auto_install_enabled_at?: string | null
          auto_install_new_assignments?: boolean
          canvas_course_id: string
          created_at?: string
          default_allowed_tools?: string[]
          default_prompt_id: string
          id?: string
          last_synced_at?: string | null
          prompt_version?: number
          teacher_id: string
          updated_at?: string
        }
        Update: {
          auto_install_enabled_at?: string | null
          auto_install_new_assignments?: boolean
          canvas_course_id?: string
          created_at?: string
          default_allowed_tools?: string[]
          default_prompt_id?: string
          id?: string
          last_synced_at?: string | null
          prompt_version?: number
          teacher_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_install_policies_default_prompt_id_fkey"
            columns: ["default_prompt_id"]
            isOneToOne: false
            referencedRelation: "prompts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "course_install_policies_teacher_id_fkey"
            columns: ["teacher_id"]
            isOneToOne: false
            referencedRelation: "teachers"
            referencedColumns: ["id"]
          },
        ]
      }
      course_rosters: {
        Row: {
          canvas_course_id: string
          last_synced_at: string
          students: Json
          teacher_id: string
        }
        Insert: {
          canvas_course_id: string
          last_synced_at?: string
          students?: Json
          teacher_id: string
        }
        Update: {
          canvas_course_id?: string
          last_synced_at?: string
          students?: Json
          teacher_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_rosters_teacher_id_fkey"
            columns: ["teacher_id"]
            isOneToOne: false
            referencedRelation: "teachers"
            referencedColumns: ["id"]
          },
        ]
      }
      gemini_usage_daily: {
        Row: {
          calls: number
          date: string
          denials: number
          teacher_id: string
          updated_at: string
        }
        Insert: {
          calls?: number
          date: string
          denials?: number
          teacher_id: string
          updated_at?: string
        }
        Update: {
          calls?: number
          date?: string
          denials?: number
          teacher_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "gemini_usage_daily_teacher_id_fkey"
            columns: ["teacher_id"]
            isOneToOne: false
            referencedRelation: "teachers"
            referencedColumns: ["id"]
          },
        ]
      }
      prompts: {
        Row: {
          body: string
          created_at: string
          id: string
          is_default: boolean
          label: string
          purpose: string
          scope: string
          student_facing_question: string | null
          teacher_id: string | null
          updated_at: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          is_default?: boolean
          label: string
          purpose?: string
          scope?: string
          student_facing_question?: string | null
          teacher_id?: string | null
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          is_default?: boolean
          label?: string
          purpose?: string
          scope?: string
          student_facing_question?: string | null
          teacher_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "prompts_teacher_id_fkey"
            columns: ["teacher_id"]
            isOneToOne: false
            referencedRelation: "teachers"
            referencedColumns: ["id"]
          },
        ]
      }
      reflection_sessions: {
        Row: {
          ai_chats: Json
          ai_tools_used: string[] | null
          canvas_submission_id: string | null
          completed_at: string | null
          completion_code: string
          created_at: string
          expires_at: string
          first_draft: string | null
          id: string
          objective_summary: string | null
          paste_fallback_text: string | null
          reflection_messages: Json
          state: Database["public"]["Enums"]["reflection_state"]
          student_id: string
          submitted_at: string | null
          teacher_assignment_id: string
          time_spent_estimate: string | null
        }
        Insert: {
          ai_chats?: Json
          ai_tools_used?: string[] | null
          canvas_submission_id?: string | null
          completed_at?: string | null
          completion_code: string
          created_at?: string
          expires_at?: string
          first_draft?: string | null
          id?: string
          objective_summary?: string | null
          paste_fallback_text?: string | null
          reflection_messages?: Json
          state?: Database["public"]["Enums"]["reflection_state"]
          student_id: string
          submitted_at?: string | null
          teacher_assignment_id: string
          time_spent_estimate?: string | null
        }
        Update: {
          ai_chats?: Json
          ai_tools_used?: string[] | null
          canvas_submission_id?: string | null
          completed_at?: string | null
          completion_code?: string
          created_at?: string
          expires_at?: string
          first_draft?: string | null
          id?: string
          objective_summary?: string | null
          paste_fallback_text?: string | null
          reflection_messages?: Json
          state?: Database["public"]["Enums"]["reflection_state"]
          student_id?: string
          submitted_at?: string | null
          teacher_assignment_id?: string
          time_spent_estimate?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reflection_sessions_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "students"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reflection_sessions_teacher_assignment_id_fkey"
            columns: ["teacher_assignment_id"]
            isOneToOne: false
            referencedRelation: "teacher_assignments"
            referencedColumns: ["id"]
          },
        ]
      }
      students: {
        Row: {
          anon_token: string
          auth_user_id: string | null
          canvas_user_id: string | null
          created_at: string
          display_name: string
          email: string
          google_sub: string | null
          id: string
        }
        Insert: {
          anon_token: string
          auth_user_id?: string | null
          canvas_user_id?: string | null
          created_at?: string
          display_name: string
          email: string
          google_sub?: string | null
          id?: string
        }
        Update: {
          anon_token?: string
          auth_user_id?: string | null
          canvas_user_id?: string | null
          created_at?: string
          display_name?: string
          email?: string
          google_sub?: string | null
          id?: string
        }
        Relationships: []
      }
      submission_attempts: {
        Row: {
          attempted_at: string
          error: string | null
          id: string
          reflection_session_id: string
          success: boolean
        }
        Insert: {
          attempted_at?: string
          error?: string | null
          id?: string
          reflection_session_id: string
          success: boolean
        }
        Update: {
          attempted_at?: string
          error?: string | null
          id?: string
          reflection_session_id?: string
          success?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "submission_attempts_reflection_session_id_fkey"
            columns: ["reflection_session_id"]
            isOneToOne: false
            referencedRelation: "reflection_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      teacher_assignments: {
        Row: {
          allowed_tools: string[]
          archived_at: string | null
          canvas_assignment_id: string
          canvas_course_id: string
          created_at: string
          id: string
          iframe_token: string
          post_to_canvas_comment: boolean
          post_to_canvas_submission: boolean
          post_to_drive: boolean
          prompt_id: string
          teacher_id: string
          updated_at: string
          use_submission_body: boolean
          written_mode_enabled: boolean
        }
        Insert: {
          allowed_tools?: string[]
          archived_at?: string | null
          canvas_assignment_id: string
          canvas_course_id: string
          created_at?: string
          id?: string
          iframe_token: string
          post_to_canvas_comment?: boolean
          post_to_canvas_submission?: boolean
          post_to_drive?: boolean
          prompt_id: string
          teacher_id: string
          updated_at?: string
          use_submission_body?: boolean
          written_mode_enabled?: boolean
        }
        Update: {
          allowed_tools?: string[]
          archived_at?: string | null
          canvas_assignment_id?: string
          canvas_course_id?: string
          created_at?: string
          id?: string
          iframe_token?: string
          post_to_canvas_comment?: boolean
          post_to_canvas_submission?: boolean
          post_to_drive?: boolean
          prompt_id?: string
          teacher_id?: string
          updated_at?: string
          use_submission_body?: boolean
          written_mode_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "teacher_assignments_prompt_id_fkey"
            columns: ["prompt_id"]
            isOneToOne: false
            referencedRelation: "prompts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teacher_assignments_teacher_id_fkey"
            columns: ["teacher_id"]
            isOneToOne: false
            referencedRelation: "teachers"
            referencedColumns: ["id"]
          },
        ]
      }
      teachers: {
        Row: {
          auth_user_id: string
          canvas_host: string | null
          canvas_token_encrypted: string | null
          card_body: string | null
          card_cta_label: string | null
          card_footnote: string | null
          card_kicker: string | null
          card_title: string | null
          created_at: string
          display_name: string
          email: string
          gemini_daily_cap: number | null
          google_sub: string | null
          id: string
          last_canvas_sync_at: string | null
          updated_at: string
        }
        Insert: {
          auth_user_id: string
          canvas_host?: string | null
          canvas_token_encrypted?: string | null
          card_body?: string | null
          card_cta_label?: string | null
          card_footnote?: string | null
          card_kicker?: string | null
          card_title?: string | null
          created_at?: string
          display_name: string
          email: string
          gemini_daily_cap?: number | null
          google_sub?: string | null
          id?: string
          last_canvas_sync_at?: string | null
          updated_at?: string
        }
        Update: {
          auth_user_id?: string
          canvas_host?: string | null
          canvas_token_encrypted?: string | null
          card_body?: string | null
          card_cta_label?: string | null
          card_footnote?: string | null
          card_kicker?: string | null
          card_title?: string | null
          created_at?: string
          display_name?: string
          email?: string
          gemini_daily_cap?: number | null
          google_sub?: string | null
          id?: string
          last_canvas_sync_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      check_and_increment_gemini_call: {
        Args: { p_default_cap: number; p_teacher_id: string }
        Returns: {
          allowed: boolean
          calls_today: number
          daily_cap: number
          denials_today: number
        }[]
      }
      is_admin: { Args: never; Returns: boolean }
      is_student_self: { Args: { s_id: string }; Returns: boolean }
      is_teacher_owner: { Args: { t_id: string }; Returns: boolean }
    }
    Enums: {
      install_status: "installed" | "uninstalled" | "failed"
      reflection_state:
        | "started"
        | "in_progress"
        | "completed"
        | "submitted"
        | "failed"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      install_status: ["installed", "uninstalled", "failed"],
      reflection_state: [
        "started",
        "in_progress",
        "completed",
        "submitted",
        "failed",
      ],
    },
  },
} as const
