// Database types for the Life OS schema.
// Hand-authored to match supabase/migrations exactly, because supabase gen
// types needs a running local stack (Docker). Regenerate with npm run
// db:types once the local stack runs; the output replaces this file.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

type AccountProvider = "google" | "microsoft";
type AccountConnectMode = "direct" | "forwarded";
type EventSource = "synced" | "app" | "reminder";
type WorkStreamKind =
  | "training"
  | "consulting"
  | "tech_consulting"
  | "tax_advisory"
  | "litigation"
  | "advisory"
  | "personal";
type ProjectStatus = "active" | "on_hold" | "done" | "dropped";
type TaskStatus = "inbox" | "todo" | "doing" | "done" | "dropped";
type TaskPriority = "low" | "medium" | "high";
type TaskSource = "manual" | "email" | "assistant";
type ReminderChannel = "gcal" | "in_app";
type TripPurpose = "aica" | "conference" | "leisure" | "other";
type TripStatus = "planned" | "booked" | "done" | "cancelled";
type TripExpenseCategory = "transport" | "hotel" | "per_diem" | "other";
type BillRecipient = "institute" | "client" | "other";
type BillStatus = "draft" | "sent" | "paid";
type NoteType = "meeting" | "decision" | "idea" | "reference";
type FinanceItemKind = "fd" | "mf" | "stock" | "ncd" | "other";
type FinanceKeyDateType = "maturity" | "review";
type ObligationCategory =
  | "gas"
  | "electricity"
  | "credit_card"
  | "insurance"
  | "broadband"
  | "rent"
  | "subscription"
  | "other";
type ObligationFrequency =
  | "monthly"
  | "bi_monthly"
  | "quarterly"
  | "half_yearly"
  | "yearly";
type AssistantActionMode = "auto" | "draft";
type AssistantActionStatus = "proposed" | "approved" | "executed" | "rejected";
type AssistantPersonaSource = "interview" | "seeded" | "edited";
type AuditActor = "user" | "assistant";

export type Database = {
  public: {
    Tables: {
      accounts: {
        Row: {
          id: string;
          user_id: string;
          provider: AccountProvider;
          email: string;
          label: string | null;
          scopes: string[];
          refresh_token_enc: string | null;
          calendar_sync: boolean;
          mail_scan: boolean;
          connect_mode: AccountConnectMode;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string;
          provider: AccountProvider;
          email: string;
          label?: string | null;
          scopes?: string[];
          refresh_token_enc?: string | null;
          calendar_sync?: boolean;
          mail_scan?: boolean;
          connect_mode?: AccountConnectMode;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          provider?: AccountProvider;
          email?: string;
          label?: string | null;
          scopes?: string[];
          refresh_token_enc?: string | null;
          calendar_sync?: boolean;
          mail_scan?: boolean;
          connect_mode?: AccountConnectMode;
          created_at?: string;
        };
        Relationships: [];
      };
      calendars: {
        Row: {
          id: string;
          user_id: string;
          account_id: string;
          ext_calendar_id: string;
          name: string;
          is_primary_write: boolean;
          is_reminder_home: boolean;
          color: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string;
          account_id: string;
          ext_calendar_id: string;
          name: string;
          is_primary_write?: boolean;
          is_reminder_home?: boolean;
          color?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          account_id?: string;
          ext_calendar_id?: string;
          name?: string;
          is_primary_write?: boolean;
          is_reminder_home?: boolean;
          color?: string | null;
        };
        Relationships: [];
      };
      events: {
        Row: {
          id: string;
          user_id: string;
          account_id: string | null;
          calendar_id: string | null;
          ext_event_id: string | null;
          title: string;
          description: string | null;
          location: string | null;
          start_ts: string;
          end_ts: string | null;
          all_day: boolean;
          attendees: Json | null;
          source: EventSource;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string;
          account_id?: string | null;
          calendar_id?: string | null;
          ext_event_id?: string | null;
          title: string;
          description?: string | null;
          location?: string | null;
          start_ts: string;
          end_ts?: string | null;
          all_day?: boolean;
          attendees?: Json | null;
          source?: EventSource;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          account_id?: string | null;
          calendar_id?: string | null;
          ext_event_id?: string | null;
          title?: string;
          description?: string | null;
          location?: string | null;
          start_ts?: string;
          end_ts?: string | null;
          all_day?: boolean;
          attendees?: Json | null;
          source?: EventSource;
          updated_at?: string;
        };
        Relationships: [];
      };
      work_streams: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          kind: WorkStreamKind;
          billing_entity: string | null;
          linked_account_hint: string | null;
          feeds_billing: boolean;
          active: boolean;
          notes: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string;
          name: string;
          kind: WorkStreamKind;
          billing_entity?: string | null;
          linked_account_hint?: string | null;
          feeds_billing?: boolean;
          active?: boolean;
          notes?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          kind?: WorkStreamKind;
          billing_entity?: string | null;
          linked_account_hint?: string | null;
          feeds_billing?: boolean;
          active?: boolean;
          notes?: string | null;
        };
        Relationships: [];
      };
      projects: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          work_stream_id: string;
          status: ProjectStatus;
          notes: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string;
          name: string;
          work_stream_id: string;
          status?: ProjectStatus;
          notes?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          work_stream_id?: string;
          status?: ProjectStatus;
          notes?: string | null;
        };
        Relationships: [];
      };
      tasks: {
        Row: {
          id: string;
          user_id: string;
          title: string;
          notes: string | null;
          status: TaskStatus;
          priority: TaskPriority;
          project_id: string | null;
          work_stream_id: string;
          due_ts: string | null;
          remind_offsets: number[];
          recurring_rule: string | null;
          source: TaskSource;
          external_ref: string | null;
          is_billable: boolean;
          created_at: string;
          completed_at: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string;
          title: string;
          notes?: string | null;
          status?: TaskStatus;
          priority?: TaskPriority;
          project_id?: string | null;
          work_stream_id: string;
          due_ts?: string | null;
          remind_offsets?: number[];
          recurring_rule?: string | null;
          source?: TaskSource;
          external_ref?: string | null;
          is_billable?: boolean;
          created_at?: string;
          completed_at?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          title?: string;
          notes?: string | null;
          status?: TaskStatus;
          priority?: TaskPriority;
          project_id?: string | null;
          work_stream_id?: string;
          due_ts?: string | null;
          remind_offsets?: number[];
          recurring_rule?: string | null;
          source?: TaskSource;
          external_ref?: string | null;
          is_billable?: boolean;
          created_at?: string;
          completed_at?: string | null;
        };
        Relationships: [];
      };
      reminders: {
        Row: {
          id: string;
          user_id: string;
          task_id: string | null;
          finance_item_id: string | null;
          obligation_id: string | null;
          remind_ts: string;
          ext_event_id: string | null;
          channel: ReminderChannel;
          created: boolean;
        };
        Insert: {
          id?: string;
          user_id?: string;
          task_id?: string | null;
          finance_item_id?: string | null;
          obligation_id?: string | null;
          remind_ts: string;
          ext_event_id?: string | null;
          channel?: ReminderChannel;
          created?: boolean;
        };
        Update: {
          id?: string;
          user_id?: string;
          task_id?: string | null;
          finance_item_id?: string | null;
          obligation_id?: string | null;
          remind_ts?: string;
          ext_event_id?: string | null;
          channel?: ReminderChannel;
          created?: boolean;
        };
        Relationships: [];
      };
      trips: {
        Row: {
          id: string;
          user_id: string;
          purpose: TripPurpose;
          title: string;
          work_stream_id: string;
          start_date: string | null;
          end_date: string | null;
          cities: Json | null;
          legs: Json | null;
          status: TripStatus;
          billable_to: string | null;
          notes: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string;
          purpose: TripPurpose;
          title: string;
          work_stream_id: string;
          start_date?: string | null;
          end_date?: string | null;
          cities?: Json | null;
          legs?: Json | null;
          status?: TripStatus;
          billable_to?: string | null;
          notes?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          purpose?: TripPurpose;
          title?: string;
          work_stream_id?: string;
          start_date?: string | null;
          end_date?: string | null;
          cities?: Json | null;
          legs?: Json | null;
          status?: TripStatus;
          billable_to?: string | null;
          notes?: string | null;
        };
        Relationships: [];
      };
      trip_expenses: {
        Row: {
          id: string;
          user_id: string;
          trip_id: string;
          category: TripExpenseCategory;
          amount: number;
          date: string;
          billable: boolean;
          receipt_ref: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string;
          trip_id: string;
          category: TripExpenseCategory;
          amount: number;
          date: string;
          billable?: boolean;
          receipt_ref?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          trip_id?: string;
          category?: TripExpenseCategory;
          amount?: number;
          date?: string;
          billable?: boolean;
          receipt_ref?: string | null;
        };
        Relationships: [];
      };
      bills: {
        Row: {
          id: string;
          user_id: string;
          trip_id: string | null;
          work_stream_id: string;
          bill_to: BillRecipient;
          number: string;
          date: string;
          line_items: Json;
          amount: number;
          status: BillStatus;
          pdf_ref: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string;
          trip_id?: string | null;
          work_stream_id: string;
          bill_to: BillRecipient;
          number: string;
          date: string;
          line_items?: Json;
          amount: number;
          status?: BillStatus;
          pdf_ref?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          trip_id?: string | null;
          work_stream_id?: string;
          bill_to?: BillRecipient;
          number?: string;
          date?: string;
          line_items?: Json;
          amount?: number;
          status?: BillStatus;
          pdf_ref?: string | null;
        };
        Relationships: [];
      };
      people: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          org: string | null;
          role: string | null;
          emails: string[];
          phones: string[];
          context_md: string | null;
          last_interaction: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string;
          name: string;
          org?: string | null;
          role?: string | null;
          emails?: string[];
          phones?: string[];
          context_md?: string | null;
          last_interaction?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          org?: string | null;
          role?: string | null;
          emails?: string[];
          phones?: string[];
          context_md?: string | null;
          last_interaction?: string | null;
        };
        Relationships: [];
      };
      notes: {
        Row: {
          id: string;
          user_id: string;
          type: NoteType;
          title: string;
          body_md: string | null;
          occurred_on: string | null;
          people_ids: string[];
          project_id: string | null;
          work_stream_id: string | null;
          tags: string[];
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string;
          type: NoteType;
          title: string;
          body_md?: string | null;
          occurred_on?: string | null;
          people_ids?: string[];
          project_id?: string | null;
          work_stream_id?: string | null;
          tags?: string[];
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          type?: NoteType;
          title?: string;
          body_md?: string | null;
          occurred_on?: string | null;
          people_ids?: string[];
          project_id?: string | null;
          work_stream_id?: string | null;
          tags?: string[];
          created_at?: string;
        };
        Relationships: [];
      };
      finance_items: {
        Row: {
          id: string;
          user_id: string;
          kind: FinanceItemKind;
          name: string;
          institution: string | null;
          principal_or_units: number | null;
          value: number | null;
          key_date: string | null;
          key_date_type: FinanceKeyDateType | null;
          remind: boolean;
          notes: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string;
          kind: FinanceItemKind;
          name: string;
          institution?: string | null;
          principal_or_units?: number | null;
          value?: number | null;
          key_date?: string | null;
          key_date_type?: FinanceKeyDateType | null;
          remind?: boolean;
          notes?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          kind?: FinanceItemKind;
          name?: string;
          institution?: string | null;
          principal_or_units?: number | null;
          value?: number | null;
          key_date?: string | null;
          key_date_type?: FinanceKeyDateType | null;
          remind?: boolean;
          notes?: string | null;
        };
        Relationships: [];
      };
      recurring_obligations: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          category: ObligationCategory;
          amount: number | null;
          variable_amount: boolean;
          frequency: ObligationFrequency;
          due_day: number | null;
          due_month: number | null;
          remind_offsets: number[];
          autopay: boolean;
          account_ref: string | null;
          active: boolean;
          notes: string | null;
        };
        Insert: {
          id?: string;
          user_id?: string;
          name: string;
          category: ObligationCategory;
          amount?: number | null;
          variable_amount?: boolean;
          frequency: ObligationFrequency;
          due_day?: number | null;
          due_month?: number | null;
          remind_offsets?: number[];
          autopay?: boolean;
          account_ref?: string | null;
          active?: boolean;
          notes?: string | null;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          category?: ObligationCategory;
          amount?: number | null;
          variable_amount?: boolean;
          frequency?: ObligationFrequency;
          due_day?: number | null;
          due_month?: number | null;
          remind_offsets?: number[];
          autopay?: boolean;
          account_ref?: string | null;
          active?: boolean;
          notes?: string | null;
        };
        Relationships: [];
      };
      assistant_actions: {
        Row: {
          id: string;
          user_id: string;
          kind: string;
          payload: Json;
          mode: AssistantActionMode;
          status: AssistantActionStatus;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string;
          kind: string;
          payload?: Json;
          mode?: AssistantActionMode;
          status?: AssistantActionStatus;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          kind?: string;
          payload?: Json;
          mode?: AssistantActionMode;
          status?: AssistantActionStatus;
          created_at?: string;
        };
        Relationships: [];
      };
      assistant_persona: {
        Row: {
          id: string;
          user_id: string;
          version: number;
          sections_md: string;
          source: AssistantPersonaSource;
          inferred_items: Json | null;
          active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string;
          version?: number;
          sections_md?: string;
          source: AssistantPersonaSource;
          inferred_items?: Json | null;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          version?: number;
          sections_md?: string;
          source?: AssistantPersonaSource;
          inferred_items?: Json | null;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      audit_log: {
        Row: {
          id: string;
          user_id: string;
          actor: AuditActor;
          action: string;
          entity: string;
          entity_id: string | null;
          meta: Json;
          ts: string;
        };
        Insert: {
          id?: string;
          user_id?: string;
          actor: AuditActor;
          action: string;
          entity: string;
          entity_id?: string | null;
          meta?: Json;
          ts?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          actor?: AuditActor;
          action?: string;
          entity?: string;
          entity_id?: string | null;
          meta?: Json;
          ts?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      account_provider: AccountProvider;
      account_connect_mode: AccountConnectMode;
      event_source: EventSource;
      work_stream_kind: WorkStreamKind;
      project_status: ProjectStatus;
      task_status: TaskStatus;
      task_priority: TaskPriority;
      task_source: TaskSource;
      reminder_channel: ReminderChannel;
      trip_purpose: TripPurpose;
      trip_status: TripStatus;
      trip_expense_category: TripExpenseCategory;
      bill_recipient: BillRecipient;
      bill_status: BillStatus;
      note_type: NoteType;
      finance_item_kind: FinanceItemKind;
      finance_key_date_type: FinanceKeyDateType;
      obligation_category: ObligationCategory;
      obligation_frequency: ObligationFrequency;
      assistant_action_mode: AssistantActionMode;
      assistant_action_status: AssistantActionStatus;
      assistant_persona_source: AssistantPersonaSource;
      audit_actor: AuditActor;
    };
    CompositeTypes: Record<string, never>;
  };
};
