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
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      accounts: {
        Row: {
          access_token_enc: string | null
          calendar_sync: boolean
          connect_mode: Database["public"]["Enums"]["account_connect_mode"]
          created_at: string
          email: string
          id: string
          label: string | null
          last_token_use: string | null
          mail_scan: boolean
          oauth_client: Database["public"]["Enums"]["oauth_client"] | null
          provider: Database["public"]["Enums"]["account_provider"]
          refresh_token_enc: string | null
          scopes: string[]
          slot: string | null
          status: Database["public"]["Enums"]["account_status"]
          token_expires_at: string | null
          user_id: string
        }
        Insert: {
          access_token_enc?: string | null
          calendar_sync?: boolean
          connect_mode?: Database["public"]["Enums"]["account_connect_mode"]
          created_at?: string
          email: string
          id?: string
          label?: string | null
          last_token_use?: string | null
          mail_scan?: boolean
          oauth_client?: Database["public"]["Enums"]["oauth_client"] | null
          provider: Database["public"]["Enums"]["account_provider"]
          refresh_token_enc?: string | null
          scopes?: string[]
          slot?: string | null
          status?: Database["public"]["Enums"]["account_status"]
          token_expires_at?: string | null
          user_id?: string
        }
        Update: {
          access_token_enc?: string | null
          calendar_sync?: boolean
          connect_mode?: Database["public"]["Enums"]["account_connect_mode"]
          created_at?: string
          email?: string
          id?: string
          label?: string | null
          last_token_use?: string | null
          mail_scan?: boolean
          oauth_client?: Database["public"]["Enums"]["oauth_client"] | null
          provider?: Database["public"]["Enums"]["account_provider"]
          refresh_token_enc?: string | null
          scopes?: string[]
          slot?: string | null
          status?: Database["public"]["Enums"]["account_status"]
          token_expires_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      assistant_actions: {
        Row: {
          created_at: string
          id: string
          kind: string
          mode: Database["public"]["Enums"]["assistant_action_mode"]
          payload: Json
          status: Database["public"]["Enums"]["assistant_action_status"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          mode?: Database["public"]["Enums"]["assistant_action_mode"]
          payload?: Json
          status?: Database["public"]["Enums"]["assistant_action_status"]
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          mode?: Database["public"]["Enums"]["assistant_action_mode"]
          payload?: Json
          status?: Database["public"]["Enums"]["assistant_action_status"]
          user_id?: string
        }
        Relationships: []
      }
      assistant_persona: {
        Row: {
          active: boolean
          created_at: string
          id: string
          inferred_items: Json | null
          sections_md: string
          source: Database["public"]["Enums"]["assistant_persona_source"]
          updated_at: string
          user_id: string
          version: number
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          inferred_items?: Json | null
          sections_md?: string
          source: Database["public"]["Enums"]["assistant_persona_source"]
          updated_at?: string
          user_id?: string
          version?: number
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          inferred_items?: Json | null
          sections_md?: string
          source?: Database["public"]["Enums"]["assistant_persona_source"]
          updated_at?: string
          user_id?: string
          version?: number
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          actor: Database["public"]["Enums"]["audit_actor"]
          entity: string
          entity_id: string | null
          id: string
          meta: Json
          ts: string
          user_id: string
        }
        Insert: {
          action: string
          actor: Database["public"]["Enums"]["audit_actor"]
          entity: string
          entity_id?: string | null
          id?: string
          meta?: Json
          ts?: string
          user_id?: string
        }
        Update: {
          action?: string
          actor?: Database["public"]["Enums"]["audit_actor"]
          entity?: string
          entity_id?: string | null
          id?: string
          meta?: Json
          ts?: string
          user_id?: string
        }
        Relationships: []
      }
      bills: {
        Row: {
          amount: number
          bill_to: Database["public"]["Enums"]["bill_recipient"]
          date: string
          id: string
          line_items: Json
          number: string
          pdf_ref: string | null
          status: Database["public"]["Enums"]["bill_status"]
          trip_id: string | null
          user_id: string
          work_stream_id: string
        }
        Insert: {
          amount: number
          bill_to: Database["public"]["Enums"]["bill_recipient"]
          date: string
          id?: string
          line_items?: Json
          number: string
          pdf_ref?: string | null
          status?: Database["public"]["Enums"]["bill_status"]
          trip_id?: string | null
          user_id?: string
          work_stream_id: string
        }
        Update: {
          amount?: number
          bill_to?: Database["public"]["Enums"]["bill_recipient"]
          date?: string
          id?: string
          line_items?: Json
          number?: string
          pdf_ref?: string | null
          status?: Database["public"]["Enums"]["bill_status"]
          trip_id?: string | null
          user_id?: string
          work_stream_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bills_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bills_work_stream_id_fkey"
            columns: ["work_stream_id"]
            isOneToOne: false
            referencedRelation: "work_streams"
            referencedColumns: ["id"]
          },
        ]
      }
      calendars: {
        Row: {
          account_id: string
          color: string | null
          ext_calendar_id: string
          id: string
          is_primary_write: boolean
          is_reminder_home: boolean
          last_synced_at: string | null
          name: string
          sync_enabled: boolean
          sync_token: string | null
          user_id: string
        }
        Insert: {
          account_id: string
          color?: string | null
          ext_calendar_id: string
          id?: string
          is_primary_write?: boolean
          is_reminder_home?: boolean
          last_synced_at?: string | null
          name: string
          sync_enabled?: boolean
          sync_token?: string | null
          user_id?: string
        }
        Update: {
          account_id?: string
          color?: string | null
          ext_calendar_id?: string
          id?: string
          is_primary_write?: boolean
          is_reminder_home?: boolean
          last_synced_at?: string | null
          name?: string
          sync_enabled?: boolean
          sync_token?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendars_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          account_id: string | null
          all_day: boolean
          attendees: Json | null
          calendar_id: string | null
          description: string | null
          end_ts: string | null
          ext_event_id: string | null
          id: string
          location: string | null
          source: Database["public"]["Enums"]["event_source"]
          start_ts: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          account_id?: string | null
          all_day?: boolean
          attendees?: Json | null
          calendar_id?: string | null
          description?: string | null
          end_ts?: string | null
          ext_event_id?: string | null
          id?: string
          location?: string | null
          source?: Database["public"]["Enums"]["event_source"]
          start_ts: string
          title: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          account_id?: string | null
          all_day?: boolean
          attendees?: Json | null
          calendar_id?: string | null
          description?: string | null
          end_ts?: string | null
          ext_event_id?: string | null
          id?: string
          location?: string | null
          source?: Database["public"]["Enums"]["event_source"]
          start_ts?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "events_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "events_calendar_id_fkey"
            columns: ["calendar_id"]
            isOneToOne: false
            referencedRelation: "calendars"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_items: {
        Row: {
          id: string
          institution: string | null
          key_date: string | null
          key_date_type:
            | Database["public"]["Enums"]["finance_key_date_type"]
            | null
          kind: Database["public"]["Enums"]["finance_item_kind"]
          name: string
          notes: string | null
          principal_or_units: number | null
          remind: boolean
          user_id: string
          value: number | null
        }
        Insert: {
          id?: string
          institution?: string | null
          key_date?: string | null
          key_date_type?:
            | Database["public"]["Enums"]["finance_key_date_type"]
            | null
          kind: Database["public"]["Enums"]["finance_item_kind"]
          name: string
          notes?: string | null
          principal_or_units?: number | null
          remind?: boolean
          user_id?: string
          value?: number | null
        }
        Update: {
          id?: string
          institution?: string | null
          key_date?: string | null
          key_date_type?:
            | Database["public"]["Enums"]["finance_key_date_type"]
            | null
          kind?: Database["public"]["Enums"]["finance_item_kind"]
          name?: string
          notes?: string | null
          principal_or_units?: number | null
          remind?: boolean
          user_id?: string
          value?: number | null
        }
        Relationships: []
      }
      notes: {
        Row: {
          body_md: string | null
          created_at: string
          id: string
          occurred_on: string | null
          people_ids: string[]
          project_id: string | null
          tags: string[]
          title: string
          type: Database["public"]["Enums"]["note_type"]
          user_id: string
          work_stream_id: string | null
        }
        Insert: {
          body_md?: string | null
          created_at?: string
          id?: string
          occurred_on?: string | null
          people_ids?: string[]
          project_id?: string | null
          tags?: string[]
          title: string
          type: Database["public"]["Enums"]["note_type"]
          user_id?: string
          work_stream_id?: string | null
        }
        Update: {
          body_md?: string | null
          created_at?: string
          id?: string
          occurred_on?: string | null
          people_ids?: string[]
          project_id?: string | null
          tags?: string[]
          title?: string
          type?: Database["public"]["Enums"]["note_type"]
          user_id?: string
          work_stream_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notes_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_work_stream_id_fkey"
            columns: ["work_stream_id"]
            isOneToOne: false
            referencedRelation: "work_streams"
            referencedColumns: ["id"]
          },
        ]
      }
      people: {
        Row: {
          context_md: string | null
          emails: string[]
          id: string
          last_interaction: string | null
          name: string
          org: string | null
          phones: string[]
          role: string | null
          user_id: string
        }
        Insert: {
          context_md?: string | null
          emails?: string[]
          id?: string
          last_interaction?: string | null
          name: string
          org?: string | null
          phones?: string[]
          role?: string | null
          user_id?: string
        }
        Update: {
          context_md?: string | null
          emails?: string[]
          id?: string
          last_interaction?: string | null
          name?: string
          org?: string | null
          phones?: string[]
          role?: string | null
          user_id?: string
        }
        Relationships: []
      }
      projects: {
        Row: {
          id: string
          name: string
          notes: string | null
          status: Database["public"]["Enums"]["project_status"]
          user_id: string
          work_stream_id: string
        }
        Insert: {
          id?: string
          name: string
          notes?: string | null
          status?: Database["public"]["Enums"]["project_status"]
          user_id?: string
          work_stream_id: string
        }
        Update: {
          id?: string
          name?: string
          notes?: string | null
          status?: Database["public"]["Enums"]["project_status"]
          user_id?: string
          work_stream_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_work_stream_id_fkey"
            columns: ["work_stream_id"]
            isOneToOne: false
            referencedRelation: "work_streams"
            referencedColumns: ["id"]
          },
        ]
      }
      recurring_obligations: {
        Row: {
          account_ref: string | null
          active: boolean
          amount: number | null
          autopay: boolean
          category: Database["public"]["Enums"]["obligation_category"]
          due_day: number | null
          due_month: number | null
          frequency: Database["public"]["Enums"]["obligation_frequency"]
          id: string
          name: string
          notes: string | null
          remind_offsets: number[]
          user_id: string
          variable_amount: boolean
        }
        Insert: {
          account_ref?: string | null
          active?: boolean
          amount?: number | null
          autopay?: boolean
          category: Database["public"]["Enums"]["obligation_category"]
          due_day?: number | null
          due_month?: number | null
          frequency: Database["public"]["Enums"]["obligation_frequency"]
          id?: string
          name: string
          notes?: string | null
          remind_offsets?: number[]
          user_id?: string
          variable_amount?: boolean
        }
        Update: {
          account_ref?: string | null
          active?: boolean
          amount?: number | null
          autopay?: boolean
          category?: Database["public"]["Enums"]["obligation_category"]
          due_day?: number | null
          due_month?: number | null
          frequency?: Database["public"]["Enums"]["obligation_frequency"]
          id?: string
          name?: string
          notes?: string | null
          remind_offsets?: number[]
          user_id?: string
          variable_amount?: boolean
        }
        Relationships: []
      }
      reminders: {
        Row: {
          channel: Database["public"]["Enums"]["reminder_channel"]
          created: boolean
          ext_event_id: string | null
          finance_item_id: string | null
          id: string
          obligation_id: string | null
          remind_ts: string
          task_id: string | null
          user_id: string
        }
        Insert: {
          channel?: Database["public"]["Enums"]["reminder_channel"]
          created?: boolean
          ext_event_id?: string | null
          finance_item_id?: string | null
          id?: string
          obligation_id?: string | null
          remind_ts: string
          task_id?: string | null
          user_id?: string
        }
        Update: {
          channel?: Database["public"]["Enums"]["reminder_channel"]
          created?: boolean
          ext_event_id?: string | null
          finance_item_id?: string | null
          id?: string
          obligation_id?: string | null
          remind_ts?: string
          task_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reminders_finance_item_id_fkey"
            columns: ["finance_item_id"]
            isOneToOne: false
            referencedRelation: "finance_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reminders_obligation_id_fkey"
            columns: ["obligation_id"]
            isOneToOne: false
            referencedRelation: "recurring_obligations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reminders_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          completed_at: string | null
          created_at: string
          due_ts: string | null
          external_ref: string | null
          id: string
          is_billable: boolean
          notes: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          project_id: string | null
          recurring_rule: string | null
          remind_offsets: number[]
          source: Database["public"]["Enums"]["task_source"]
          status: Database["public"]["Enums"]["task_status"]
          title: string
          user_id: string
          work_stream_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          due_ts?: string | null
          external_ref?: string | null
          id?: string
          is_billable?: boolean
          notes?: string | null
          priority?: Database["public"]["Enums"]["task_priority"]
          project_id?: string | null
          recurring_rule?: string | null
          remind_offsets?: number[]
          source?: Database["public"]["Enums"]["task_source"]
          status?: Database["public"]["Enums"]["task_status"]
          title: string
          user_id?: string
          work_stream_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          due_ts?: string | null
          external_ref?: string | null
          id?: string
          is_billable?: boolean
          notes?: string | null
          priority?: Database["public"]["Enums"]["task_priority"]
          project_id?: string | null
          recurring_rule?: string | null
          remind_offsets?: number[]
          source?: Database["public"]["Enums"]["task_source"]
          status?: Database["public"]["Enums"]["task_status"]
          title?: string
          user_id?: string
          work_stream_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_work_stream_id_fkey"
            columns: ["work_stream_id"]
            isOneToOne: false
            referencedRelation: "work_streams"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_expenses: {
        Row: {
          amount: number
          billable: boolean
          category: Database["public"]["Enums"]["trip_expense_category"]
          date: string
          id: string
          receipt_ref: string | null
          trip_id: string
          user_id: string
        }
        Insert: {
          amount: number
          billable?: boolean
          category: Database["public"]["Enums"]["trip_expense_category"]
          date: string
          id?: string
          receipt_ref?: string | null
          trip_id: string
          user_id?: string
        }
        Update: {
          amount?: number
          billable?: boolean
          category?: Database["public"]["Enums"]["trip_expense_category"]
          date?: string
          id?: string
          receipt_ref?: string | null
          trip_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_expenses_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trips: {
        Row: {
          billable_to: string | null
          cities: Json | null
          end_date: string | null
          id: string
          legs: Json | null
          notes: string | null
          purpose: Database["public"]["Enums"]["trip_purpose"]
          start_date: string | null
          status: Database["public"]["Enums"]["trip_status"]
          title: string
          user_id: string
          work_stream_id: string
        }
        Insert: {
          billable_to?: string | null
          cities?: Json | null
          end_date?: string | null
          id?: string
          legs?: Json | null
          notes?: string | null
          purpose: Database["public"]["Enums"]["trip_purpose"]
          start_date?: string | null
          status?: Database["public"]["Enums"]["trip_status"]
          title: string
          user_id?: string
          work_stream_id: string
        }
        Update: {
          billable_to?: string | null
          cities?: Json | null
          end_date?: string | null
          id?: string
          legs?: Json | null
          notes?: string | null
          purpose?: Database["public"]["Enums"]["trip_purpose"]
          start_date?: string | null
          status?: Database["public"]["Enums"]["trip_status"]
          title?: string
          user_id?: string
          work_stream_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trips_work_stream_id_fkey"
            columns: ["work_stream_id"]
            isOneToOne: false
            referencedRelation: "work_streams"
            referencedColumns: ["id"]
          },
        ]
      }
      work_streams: {
        Row: {
          active: boolean
          billing_entity: string | null
          feeds_billing: boolean
          id: string
          kind: Database["public"]["Enums"]["work_stream_kind"]
          linked_account_hint: string | null
          name: string
          notes: string | null
          user_id: string
        }
        Insert: {
          active?: boolean
          billing_entity?: string | null
          feeds_billing?: boolean
          id?: string
          kind: Database["public"]["Enums"]["work_stream_kind"]
          linked_account_hint?: string | null
          name: string
          notes?: string | null
          user_id?: string
        }
        Update: {
          active?: boolean
          billing_entity?: string | null
          feeds_billing?: boolean
          id?: string
          kind?: Database["public"]["Enums"]["work_stream_kind"]
          linked_account_hint?: string | null
          name?: string
          notes?: string | null
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      clear_account_tokens: {
        Args: { p_account_id: string }
        Returns: undefined
      }
      get_account_tokens: {
        Args: { p_account_id: string }
        Returns: {
          access_token: string
          refresh_token: string
          token_expires_at: string
        }[]
      }
      set_account_tokens: {
        Args: {
          p_access?: string
          p_access_expires?: string
          p_account_id: string
          p_refresh?: string
        }
        Returns: undefined
      }
    }
    Enums: {
      account_connect_mode: "direct" | "forwarded"
      account_provider: "google" | "microsoft"
      account_status:
        | "connected"
        | "needs_reauth"
        | "forwarded"
        | "disconnected"
      assistant_action_mode: "auto" | "draft"
      assistant_action_status: "proposed" | "approved" | "executed" | "rejected"
      assistant_persona_source: "interview" | "seeded" | "edited"
      audit_actor: "user" | "assistant"
      bill_recipient: "institute" | "client" | "other"
      bill_status: "draft" | "sent" | "paid"
      event_source: "synced" | "app" | "reminder"
      finance_item_kind: "fd" | "mf" | "stock" | "ncd" | "other"
      finance_key_date_type: "maturity" | "review"
      note_type: "meeting" | "decision" | "idea" | "reference"
      oauth_client: "google_internal" | "google_external" | "microsoft"
      obligation_category:
        | "gas"
        | "electricity"
        | "credit_card"
        | "insurance"
        | "broadband"
        | "rent"
        | "subscription"
        | "other"
      obligation_frequency:
        | "monthly"
        | "bi_monthly"
        | "quarterly"
        | "half_yearly"
        | "yearly"
      project_status: "active" | "on_hold" | "done" | "dropped"
      reminder_channel: "gcal" | "in_app"
      task_priority: "low" | "medium" | "high"
      task_source: "manual" | "email" | "assistant"
      task_status: "inbox" | "todo" | "doing" | "done" | "dropped"
      trip_expense_category: "transport" | "hotel" | "per_diem" | "other"
      trip_purpose: "aica" | "conference" | "leisure" | "other"
      trip_status: "planned" | "booked" | "done" | "cancelled"
      work_stream_kind:
        | "training"
        | "consulting"
        | "tech_consulting"
        | "tax_advisory"
        | "litigation"
        | "advisory"
        | "personal"
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      account_connect_mode: ["direct", "forwarded"],
      account_provider: ["google", "microsoft"],
      account_status: [
        "connected",
        "needs_reauth",
        "forwarded",
        "disconnected",
      ],
      assistant_action_mode: ["auto", "draft"],
      assistant_action_status: ["proposed", "approved", "executed", "rejected"],
      assistant_persona_source: ["interview", "seeded", "edited"],
      audit_actor: ["user", "assistant"],
      bill_recipient: ["institute", "client", "other"],
      bill_status: ["draft", "sent", "paid"],
      event_source: ["synced", "app", "reminder"],
      finance_item_kind: ["fd", "mf", "stock", "ncd", "other"],
      finance_key_date_type: ["maturity", "review"],
      note_type: ["meeting", "decision", "idea", "reference"],
      oauth_client: ["google_internal", "google_external", "microsoft"],
      obligation_category: [
        "gas",
        "electricity",
        "credit_card",
        "insurance",
        "broadband",
        "rent",
        "subscription",
        "other",
      ],
      obligation_frequency: [
        "monthly",
        "bi_monthly",
        "quarterly",
        "half_yearly",
        "yearly",
      ],
      project_status: ["active", "on_hold", "done", "dropped"],
      reminder_channel: ["gcal", "in_app"],
      task_priority: ["low", "medium", "high"],
      task_source: ["manual", "email", "assistant"],
      task_status: ["inbox", "todo", "doing", "done", "dropped"],
      trip_expense_category: ["transport", "hotel", "per_diem", "other"],
      trip_purpose: ["aica", "conference", "leisure", "other"],
      trip_status: ["planned", "booked", "done", "cancelled"],
      work_stream_kind: [
        "training",
        "consulting",
        "tech_consulting",
        "tax_advisory",
        "litigation",
        "advisory",
        "personal",
      ],
    },
  },
} as const
