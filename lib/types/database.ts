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
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      ai_usage_logs: {
        Row: {
          created_at: string
          feature: string
          fund_id: string
          id: string
          input_tokens: number
          model: string
          output_tokens: number
          provider: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          feature: string
          fund_id: string
          id?: string
          input_tokens?: number
          model: string
          output_tokens?: number
          provider: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          feature?: string
          fund_id?: string
          id?: string
          input_tokens?: number
          model?: string
          output_tokens?: number
          provider?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_logs_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      allowed_signups: {
        Row: {
          created_at: string | null
          email_pattern: string
          id: string
        }
        Insert: {
          created_at?: string | null
          email_pattern: string
          id?: string
        }
        Update: {
          created_at?: string | null
          email_pattern?: string
          id?: string
        }
        Relationships: []
      }
      analyst_conversations: {
        Row: {
          company_id: string | null
          created_at: string
          deal_id: string | null
          fund_id: string
          id: string
          message_count: number
          messages: Json
          scope: string | null
          summary: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          deal_id?: string | null
          fund_id: string
          id?: string
          message_count?: number
          messages?: Json
          scope?: string | null
          summary?: string | null
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          company_id?: string | null
          created_at?: string
          deal_id?: string | null
          fund_id?: string
          id?: string
          message_count?: number
          messages?: Json
          scope?: string | null
          summary?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "analyst_conversations_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analyst_conversations_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      app_settings: {
        Row: {
          created_at: string | null
          github_stars: number | null
          github_stars_checked_at: string | null
          global_inbound_address: string | null
          global_inbound_token: string | null
          global_inbound_token_encrypted: string | null
          id: string
          installation_id: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          github_stars?: number | null
          github_stars_checked_at?: string | null
          global_inbound_address?: string | null
          global_inbound_token?: string | null
          global_inbound_token_encrypted?: string | null
          id?: string
          installation_id?: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          github_stars?: number | null
          github_stars_checked_at?: string | null
          global_inbound_address?: string | null
          global_inbound_token?: string | null
          global_inbound_token_encrypted?: string | null
          id?: string
          installation_id?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      authorized_senders: {
        Row: {
          created_at: string | null
          email: string
          fund_id: string
          id: string
          label: string | null
        }
        Insert: {
          created_at?: string | null
          email: string
          fund_id: string
          id?: string
          label?: string | null
        }
        Update: {
          created_at?: string | null
          email?: string
          fund_id?: string
          id?: string
          label?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "authorized_senders_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      companies: {
        Row: {
          aliases: string[] | null
          contact_email: string[] | null
          created_at: string | null
          current_update: string | null
          founded_year: number | null
          founders: string | null
          fund_id: string
          google_drive_folder_id: string | null
          google_drive_folder_name: string | null
          id: string
          industry: string[] | null
          name: string
          notes: string | null
          overview: string | null
          portfolio_group: string[] | null
          stage: string | null
          status: string | null
          tags: string[] | null
          updated_at: string | null
          why_invested: string | null
        }
        Insert: {
          aliases?: string[] | null
          contact_email?: string[] | null
          created_at?: string | null
          current_update?: string | null
          founded_year?: number | null
          founders?: string | null
          fund_id: string
          google_drive_folder_id?: string | null
          google_drive_folder_name?: string | null
          id?: string
          industry?: string[] | null
          name: string
          notes?: string | null
          overview?: string | null
          portfolio_group?: string[] | null
          stage?: string | null
          status?: string | null
          tags?: string[] | null
          updated_at?: string | null
          why_invested?: string | null
        }
        Update: {
          aliases?: string[] | null
          contact_email?: string[] | null
          created_at?: string | null
          current_update?: string | null
          founded_year?: number | null
          founders?: string | null
          fund_id?: string
          google_drive_folder_id?: string | null
          google_drive_folder_name?: string | null
          id?: string
          industry?: string[] | null
          name?: string
          notes?: string | null
          overview?: string | null
          portfolio_group?: string[] | null
          stage?: string | null
          status?: string | null
          tags?: string[] | null
          updated_at?: string | null
          why_invested?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "companies_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      company_documents: {
        Row: {
          company_id: string
          created_at: string | null
          extracted_text: string | null
          file_size: number
          file_type: string
          filename: string
          fund_id: string
          has_native_content: boolean | null
          id: string
          storage_path: string | null
          uploaded_by: string | null
        }
        Insert: {
          company_id: string
          created_at?: string | null
          extracted_text?: string | null
          file_size: number
          file_type: string
          filename: string
          fund_id: string
          has_native_content?: boolean | null
          id?: string
          storage_path?: string | null
          uploaded_by?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string | null
          extracted_text?: string | null
          file_size?: number
          file_type?: string
          filename?: string
          fund_id?: string
          has_native_content?: boolean | null
          id?: string
          storage_path?: string | null
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "company_documents_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_documents_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      company_update_artifacts: {
        Row: {
          attachment_key: string
          byte_size: number | null
          company_id: string
          content_sha256: string | null
          created_at: string
          declared_content_type: string | null
          detected_content_type: string | null
          extracted_text: string | null
          extraction_error: string | null
          extraction_status: string
          filename: string
          fund_id: string
          id: string
          metadata: Json
          ocr_attempts: number
          ocr_error: string | null
          ocr_status: string
          ocr_updated_at: string | null
          ordinal: number
          parser: string | null
          parser_version: string | null
          storage_path: string | null
          update_id: string
          updated_at: string
          warnings: Json
        }
        Insert: {
          attachment_key: string
          byte_size?: number | null
          company_id: string
          content_sha256?: string | null
          created_at?: string
          declared_content_type?: string | null
          detected_content_type?: string | null
          extracted_text?: string | null
          extraction_error?: string | null
          extraction_status?: string
          filename: string
          fund_id: string
          id?: string
          metadata?: Json
          ocr_attempts?: number
          ocr_error?: string | null
          ocr_status?: string
          ocr_updated_at?: string | null
          ordinal: number
          parser?: string | null
          parser_version?: string | null
          storage_path?: string | null
          update_id: string
          updated_at?: string
          warnings?: Json
        }
        Update: {
          attachment_key?: string
          byte_size?: number | null
          company_id?: string
          content_sha256?: string | null
          created_at?: string
          declared_content_type?: string | null
          detected_content_type?: string | null
          extracted_text?: string | null
          extraction_error?: string | null
          extraction_status?: string
          filename?: string
          fund_id?: string
          id?: string
          metadata?: Json
          ocr_attempts?: number
          ocr_error?: string | null
          ocr_status?: string
          ocr_updated_at?: string | null
          ordinal?: number
          parser?: string | null
          parser_version?: string | null
          storage_path?: string | null
          update_id?: string
          updated_at?: string
          warnings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "company_update_artifacts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_update_artifacts_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_update_artifacts_update_id_fkey"
            columns: ["update_id"]
            isOneToOne: false
            referencedRelation: "company_updates"
            referencedColumns: ["id"]
          },
        ]
      }
      company_update_backfill_items: {
        Row: {
          attempts: number
          claimed_at: string | null
          created_at: string
          email_id: string
          error: string | null
          finished_at: string | null
          fund_id: string
          id: string
          job_id: string
          result: Json | null
          status: string
        }
        Insert: {
          attempts?: number
          claimed_at?: string | null
          created_at?: string
          email_id: string
          error?: string | null
          finished_at?: string | null
          fund_id: string
          id?: string
          job_id: string
          result?: Json | null
          status?: string
        }
        Update: {
          attempts?: number
          claimed_at?: string | null
          created_at?: string
          email_id?: string
          error?: string | null
          finished_at?: string | null
          fund_id?: string
          id?: string
          job_id?: string
          result?: Json | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_update_backfill_items_email_id_fkey"
            columns: ["email_id"]
            isOneToOne: false
            referencedRelation: "inbound_emails"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_update_backfill_items_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_update_backfill_items_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "company_update_backfill_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      company_update_backfill_jobs: {
        Row: {
          concurrency: number
          counts: Json
          created_at: string
          created_by: string | null
          finished_at: string | null
          fund_id: string
          id: string
          last_error: string | null
          mode: string
          parser_version: string
          plan_cursor: Json | null
          planned: number
          reprocess: boolean
          sample_company_id: string | null
          sample_limit: number | null
          started_at: string | null
          status: string
          total_eligible: number
          updated_at: string
        }
        Insert: {
          concurrency?: number
          counts?: Json
          created_at?: string
          created_by?: string | null
          finished_at?: string | null
          fund_id: string
          id?: string
          last_error?: string | null
          mode: string
          parser_version: string
          plan_cursor?: Json | null
          planned?: number
          reprocess?: boolean
          sample_company_id?: string | null
          sample_limit?: number | null
          started_at?: string | null
          status?: string
          total_eligible?: number
          updated_at?: string
        }
        Update: {
          concurrency?: number
          counts?: Json
          created_at?: string
          created_by?: string | null
          finished_at?: string | null
          fund_id?: string
          id?: string
          last_error?: string | null
          mode?: string
          parser_version?: string
          plan_cursor?: Json | null
          planned?: number
          reprocess?: boolean
          sample_company_id?: string | null
          sample_limit?: number | null
          started_at?: string | null
          status?: string
          total_eligible?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_update_backfill_jobs_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_update_backfill_jobs_sample_company_id_fkey"
            columns: ["sample_company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      company_update_chunks: {
        Row: {
          artifact_id: string | null
          chunk_kind: string
          company_id: string
          content: string
          created_at: string
          fund_id: string
          id: string
          locator: Json
          ordinal: number
          parser_version: string
          search: unknown | null
          update_id: string
        }
        Insert: {
          artifact_id?: string | null
          chunk_kind: string
          company_id: string
          content: string
          created_at?: string
          fund_id: string
          id?: string
          locator?: Json
          ordinal: number
          parser_version: string
          search?: unknown | null
          update_id: string
        }
        Update: {
          artifact_id?: string | null
          chunk_kind?: string
          company_id?: string
          content?: string
          created_at?: string
          fund_id?: string
          id?: string
          locator?: Json
          ordinal?: number
          parser_version?: string
          search?: unknown | null
          update_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_update_chunks_artifact_id_fkey"
            columns: ["artifact_id"]
            isOneToOne: false
            referencedRelation: "company_update_artifacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_update_chunks_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_update_chunks_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_update_chunks_update_id_fkey"
            columns: ["update_id"]
            isOneToOne: false
            referencedRelation: "company_updates"
            referencedColumns: ["id"]
          },
        ]
      }
      company_updates: {
        Row: {
          body_cleaner_version: string | null
          body_cleaning_status: string
          body_current: string | null
          body_original: string | null
          body_status: string
          company_id: string
          created_at: string
          extraction_status: string
          forwarded_sender_email: string | null
          forwarded_sender_name: string | null
          fund_id: string
          id: string
          parser_version: string | null
          period_label: string | null
          period_month: number | null
          period_quarter: number | null
          period_source: string | null
          period_year: number | null
          received_at: string
          sender_email: string | null
          sender_name: string | null
          source: string
          source_email_id: string
          source_route: string
          subject: string | null
          updated_at: string
          warnings: Json
        }
        Insert: {
          body_cleaner_version?: string | null
          body_cleaning_status?: string
          body_current?: string | null
          body_original?: string | null
          body_status?: string
          company_id: string
          created_at?: string
          extraction_status?: string
          forwarded_sender_email?: string | null
          forwarded_sender_name?: string | null
          fund_id: string
          id?: string
          parser_version?: string | null
          period_label?: string | null
          period_month?: number | null
          period_quarter?: number | null
          period_source?: string | null
          period_year?: number | null
          received_at: string
          sender_email?: string | null
          sender_name?: string | null
          source?: string
          source_email_id: string
          source_route?: string
          subject?: string | null
          updated_at?: string
          warnings?: Json
        }
        Update: {
          body_cleaner_version?: string | null
          body_cleaning_status?: string
          body_current?: string | null
          body_original?: string | null
          body_status?: string
          company_id?: string
          created_at?: string
          extraction_status?: string
          forwarded_sender_email?: string | null
          forwarded_sender_name?: string | null
          fund_id?: string
          id?: string
          parser_version?: string | null
          period_label?: string | null
          period_month?: number | null
          period_quarter?: number | null
          period_source?: string | null
          period_year?: number | null
          received_at?: string
          sender_email?: string | null
          sender_name?: string | null
          source?: string
          source_email_id?: string
          source_route?: string
          subject?: string | null
          updated_at?: string
          warnings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "company_updates_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_updates_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_updates_source_email_id_fkey"
            columns: ["source_email_id"]
            isOneToOne: true
            referencedRelation: "inbound_emails"
            referencedColumns: ["id"]
          },
        ]
      }
      compliance_deadlines: {
        Row: {
          id: string
          fund_id: string
          compliance_item_id: string
          title: string
          due_date: string
          status: string
          notes: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          fund_id: string
          compliance_item_id: string
          title: string
          due_date: string
          status?: string
          notes?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          fund_id?: string
          compliance_item_id?: string
          title?: string
          due_date?: string
          status?: string
          notes?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "compliance_deadlines_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      compliance_fund_settings: {
        Row: {
          id: string
          fund_id: string
          compliance_item_id: string
          applies: string
          dismissed: boolean
          dismissed_reason: string | null
          dismissed_by: string | null
          dismissed_at: string | null
          notes: string | null
          updated_at: string
        }
        Insert: {
          id?: string
          fund_id: string
          compliance_item_id: string
          applies?: string
          dismissed?: boolean
          dismissed_reason?: string | null
          dismissed_by?: string | null
          dismissed_at?: string | null
          notes?: string | null
          updated_at?: string
        }
        Update: {
          id?: string
          fund_id?: string
          compliance_item_id?: string
          applies?: string
          dismissed?: boolean
          dismissed_reason?: string | null
          dismissed_by?: string | null
          dismissed_at?: string | null
          notes?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "compliance_fund_settings_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      compliance_items: {
        Row: {
          id: string
          category: string
          title: string
          description: string | null
          frequency: string | null
          sort_order: number
          created_at: string
        }
        Insert: {
          id?: string
          category: string
          title: string
          description?: string | null
          frequency?: string | null
          sort_order?: number
          created_at?: string
        }
        Update: {
          id?: string
          category?: string
          title?: string
          description?: string | null
          frequency?: string | null
          sort_order?: number
          created_at?: string
        }
        Relationships: []
      }
      company_notes: {
        Row: {
          company_id: string | null
          content: string
          created_at: string
          fund_id: string
          id: string
          mentioned_company_ids: string[] | null
          mentioned_groups: string[] | null
          mentioned_user_ids: string[] | null
          updated_at: string
          user_id: string
        }
        Insert: {
          company_id?: string | null
          content: string
          created_at?: string
          fund_id: string
          id?: string
          mentioned_company_ids?: string[] | null
          mentioned_groups?: string[] | null
          mentioned_user_ids?: string[] | null
          updated_at?: string
          user_id: string
        }
        Update: {
          company_id?: string | null
          content?: string
          created_at?: string
          fund_id?: string
          id?: string
          mentioned_company_ids?: string[] | null
          mentioned_groups?: string[] | null
          mentioned_user_ids?: string[] | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_notes_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_notes_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      company_summaries: {
        Row: {
          company_id: string
          created_at: string
          fund_id: string
          id: string
          period_label: string | null
          summary_text: string
        }
        Insert: {
          company_id: string
          created_at?: string
          fund_id: string
          id?: string
          period_label?: string | null
          summary_text: string
        }
        Update: {
          company_id?: string
          created_at?: string
          fund_id?: string
          id?: string
          period_label?: string | null
          summary_text?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_summaries_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_summaries_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      email_requests: {
        Row: {
          bcc: string | null
          body_html: string
          cc: string | null
          created_at: string
          due_date: string | null
          fund_id: string
          id: string
          quarter: number | null
          quarter_label: string | null
          recipients: Json
          send_results: Json | null
          sent_at: string | null
          sent_by: string
          status: string
          subject: string
          updated_at: string
          year: number | null
        }
        Insert: {
          bcc?: string | null
          body_html: string
          cc?: string | null
          created_at?: string
          due_date?: string | null
          fund_id: string
          id?: string
          quarter?: number | null
          quarter_label?: string | null
          recipients?: Json
          send_results?: Json | null
          sent_at?: string | null
          sent_by: string
          status?: string
          subject: string
          updated_at?: string
          year?: number | null
        }
        Update: {
          bcc?: string | null
          body_html?: string
          cc?: string | null
          created_at?: string
          due_date?: string | null
          fund_id?: string
          id?: string
          quarter?: number | null
          quarter_label?: string | null
          recipients?: Json
          send_results?: Json | null
          sent_at?: string | null
          sent_by?: string
          status?: string
          subject?: string
          updated_at?: string
          year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "email_requests_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      fund_cash_flows: {
        Row: {
          amount: number
          created_at: string | null
          flow_date: string
          flow_type: string
          fund_id: string
          id: string
          notes: string | null
          portfolio_group: string
          updated_at: string | null
        }
        Insert: {
          amount: number
          created_at?: string | null
          flow_date: string
          flow_type: string
          fund_id: string
          id?: string
          notes?: string | null
          portfolio_group: string
          updated_at?: string | null
        }
        Update: {
          amount?: number
          created_at?: string | null
          flow_date?: string
          flow_type?: string
          fund_id?: string
          id?: string
          notes?: string | null
          portfolio_group?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fund_cash_flows_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      fund_compliance_profile: {
        Row: {
          id: string
          fund_id: string
          registration_status: string | null
          aum_range: string | null
          fund_structure: string | null
          fundraising_status: string | null
          reg_d_exemption: string | null
          investor_state_count: string | null
          california_nexus: string[] | null
          public_equity: string | null
          cftc_activity: string | null
          access_person_count: string | null
          has_foreign_entities: string | null
          completed_at: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          id?: string
          fund_id: string
          registration_status?: string | null
          aum_range?: string | null
          fund_structure?: string | null
          fundraising_status?: string | null
          reg_d_exemption?: string | null
          investor_state_count?: string | null
          california_nexus?: string[] | null
          public_equity?: string | null
          cftc_activity?: string | null
          access_person_count?: string | null
          has_foreign_entities?: string | null
          completed_at?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          id?: string
          fund_id?: string
          registration_status?: string | null
          aum_range?: string | null
          fund_structure?: string | null
          fundraising_status?: string | null
          reg_d_exemption?: string | null
          investor_state_count?: string | null
          california_nexus?: string[] | null
          public_equity?: string | null
          cftc_activity?: string | null
          access_person_count?: string | null
          has_foreign_entities?: string | null
          completed_at?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fund_compliance_profile_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: true
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      fund_group_config: {
        Row: {
          carry_rate: number
          cash_on_hand: number
          created_at: string | null
          fund_id: string
          gp_commit_pct: number
          id: string
          portfolio_group: string
          updated_at: string | null
          vintage: number | null
        }
        Insert: {
          carry_rate?: number
          cash_on_hand?: number
          created_at?: string | null
          fund_id: string
          gp_commit_pct?: number
          id?: string
          portfolio_group: string
          updated_at?: string | null
          vintage?: number | null
        }
        Update: {
          carry_rate?: number
          cash_on_hand?: number
          created_at?: string | null
          fund_id?: string
          gp_commit_pct?: number
          id?: string
          portfolio_group?: string
          updated_at?: string | null
          vintage?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fund_group_config_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      fund_join_requests: {
        Row: {
          created_at: string | null
          email: string
          fund_id: string
          id: string
          reviewed_by: string | null
          status: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          email: string
          fund_id: string
          id?: string
          reviewed_by?: string | null
          status?: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          email?: string
          fund_id?: string
          id?: string
          reviewed_by?: string | null
          status?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fund_join_requests_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      fund_domain_defaults: {
        Row: {
          domain: string
          fund_id: string
          level: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          domain: string
          fund_id: string
          level: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          domain?: string
          fund_id?: string
          level?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fund_domain_defaults_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      fund_member_access: {
        Row: {
          domain: string
          fund_id: string
          level: string
          updated_at: string
          updated_by: string | null
          user_id: string
        }
        Insert: {
          domain: string
          fund_id: string
          level: string
          updated_at?: string
          updated_by?: string | null
          user_id: string
        }
        Update: {
          domain?: string
          fund_id?: string
          level?: string
          updated_at?: string
          updated_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fund_member_access_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      fund_members: {
        Row: {
          created_at: string | null
          display_name: string | null
          fund_id: string
          id: string
          invited_by: string | null
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          display_name?: string | null
          fund_id: string
          id?: string
          invited_by?: string | null
          role?: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          display_name?: string | null
          fund_id?: string
          id?: string
          invited_by?: string | null
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fund_members_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      fund_settings: {
        Row: {
          ai_summary_prompt: string | null
          analytics_custom_head_script: string | null
          analytics_fathom_site_id: string | null
          analytics_ga_measurement_id: string | null
          approval_email_body: string | null
          approval_email_subject: string | null
          asks_email_provider: string | null
          claude_api_key_encrypted: string | null
          claude_model: string
          created_at: string | null
          currency: string
          deal_intake_enabled: boolean
          deal_screening_prompt: string | null
          deal_submission_token: string | null
          deal_thesis: string | null
          default_ai_provider: string
          memo_agent_monthly_token_cap: number | null
          memo_agent_per_deal_token_cap: number | null
          memo_agent_stage_models: Json | null
          memo_agent_web_search_enabled: boolean
          disable_user_tracking: boolean
          encryption_key_encrypted: string | null
          feature_visibility: Json | null
          file_storage_provider: string | null
          fund_id: string
          google_client_id: string | null
          google_client_secret_encrypted: string | null
          google_drive_folder_id: string | null
          google_drive_folder_name: string | null
          google_refresh_token_encrypted: string | null
          id: string
          inbound_email_provider: string | null
          mailgun_api_key_encrypted: string | null
          mailgun_inbound_domain: string | null
          mailgun_sending_domain: string | null
          mailgun_signing_key_encrypted: string | null
          openai_api_key_encrypted: string | null
          openai_model: string
          outbound_email_provider: string | null
          postmark_inbound_address: string | null
          postmark_server_token_encrypted: string | null
          postmark_webhook_token: string | null
          postmark_webhook_token_encrypted: string | null
          resend_api_key_encrypted: string | null
          resolved_reviews_ttl_days: number | null
          retain_resolved_reviews: boolean | null
          routing_confidence_threshold: number | null
          routing_model: string | null
          system_email_from_address: string | null
          system_email_from_name: string | null
          updated_at: string | null
        }
        Insert: {
          ai_summary_prompt?: string | null
          analytics_custom_head_script?: string | null
          analytics_fathom_site_id?: string | null
          analytics_ga_measurement_id?: string | null
          approval_email_body?: string | null
          approval_email_subject?: string | null
          asks_email_provider?: string | null
          claude_api_key_encrypted?: string | null
          claude_model?: string
          created_at?: string | null
          currency?: string
          deal_intake_enabled?: boolean
          deal_screening_prompt?: string | null
          deal_submission_token?: string | null
          deal_thesis?: string | null
          default_ai_provider?: string
          memo_agent_monthly_token_cap?: number | null
          memo_agent_per_deal_token_cap?: number | null
          memo_agent_stage_models?: Json | null
          memo_agent_web_search_enabled?: boolean
          disable_user_tracking?: boolean
          encryption_key_encrypted?: string | null
          feature_visibility?: Json | null
          file_storage_provider?: string | null
          fund_id: string
          google_client_id?: string | null
          google_client_secret_encrypted?: string | null
          google_drive_folder_id?: string | null
          google_drive_folder_name?: string | null
          google_refresh_token_encrypted?: string | null
          id?: string
          inbound_email_provider?: string | null
          mailgun_api_key_encrypted?: string | null
          mailgun_inbound_domain?: string | null
          mailgun_sending_domain?: string | null
          mailgun_signing_key_encrypted?: string | null
          openai_api_key_encrypted?: string | null
          openai_model?: string
          outbound_email_provider?: string | null
          postmark_inbound_address?: string | null
          postmark_server_token_encrypted?: string | null
          postmark_webhook_token?: string | null
          postmark_webhook_token_encrypted?: string | null
          resend_api_key_encrypted?: string | null
          resolved_reviews_ttl_days?: number | null
          retain_resolved_reviews?: boolean | null
          routing_confidence_threshold?: number | null
          routing_model?: string | null
          system_email_from_address?: string | null
          system_email_from_name?: string | null
          updated_at?: string | null
        }
        Update: {
          ai_summary_prompt?: string | null
          analytics_custom_head_script?: string | null
          analytics_fathom_site_id?: string | null
          analytics_ga_measurement_id?: string | null
          approval_email_body?: string | null
          approval_email_subject?: string | null
          asks_email_provider?: string | null
          claude_api_key_encrypted?: string | null
          claude_model?: string
          created_at?: string | null
          currency?: string
          deal_intake_enabled?: boolean
          deal_screening_prompt?: string | null
          deal_submission_token?: string | null
          deal_thesis?: string | null
          default_ai_provider?: string
          memo_agent_monthly_token_cap?: number | null
          memo_agent_per_deal_token_cap?: number | null
          memo_agent_stage_models?: Json | null
          memo_agent_web_search_enabled?: boolean
          disable_user_tracking?: boolean
          encryption_key_encrypted?: string | null
          feature_visibility?: Json | null
          file_storage_provider?: string | null
          fund_id?: string
          google_client_id?: string | null
          google_client_secret_encrypted?: string | null
          google_drive_folder_id?: string | null
          google_drive_folder_name?: string | null
          google_refresh_token_encrypted?: string | null
          id?: string
          inbound_email_provider?: string | null
          mailgun_api_key_encrypted?: string | null
          mailgun_inbound_domain?: string | null
          mailgun_sending_domain?: string | null
          mailgun_signing_key_encrypted?: string | null
          openai_api_key_encrypted?: string | null
          openai_model?: string
          outbound_email_provider?: string | null
          postmark_inbound_address?: string | null
          postmark_server_token_encrypted?: string | null
          postmark_webhook_token?: string | null
          postmark_webhook_token_encrypted?: string | null
          resend_api_key_encrypted?: string | null
          resolved_reviews_ttl_days?: number | null
          retain_resolved_reviews?: boolean | null
          routing_confidence_threshold?: number | null
          routing_model?: string | null
          system_email_from_address?: string | null
          system_email_from_name?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fund_settings_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: true
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      firm_schemas: {
        Row: {
          id: string
          fund_id: string
          schema_name: string
          schema_version: string
          yaml_content: string
          parsed_content: Json | null
          is_active: boolean
          edit_note: string | null
          edited_by: string | null
          edited_at: string
          created_at: string
        }
        Insert: {
          id?: string
          fund_id: string
          schema_name: string
          schema_version: string
          yaml_content: string
          parsed_content?: Json | null
          is_active?: boolean
          edit_note?: string | null
          edited_by?: string | null
          edited_at?: string
          created_at?: string
        }
        Update: {
          id?: string
          fund_id?: string
          schema_name?: string
          schema_version?: string
          yaml_content?: string
          parsed_content?: Json | null
          is_active?: boolean
          edit_note?: string | null
          edited_by?: string | null
          edited_at?: string
          created_at?: string
        }
        Relationships: []
      }
      diligence_deals: {
        Row: {
          id: string
          fund_id: string
          name: string
          aliases: string[] | null
          sector: string | null
          stage_at_consideration: string | null
          deal_status: string
          current_memo_stage: string
          lead_partner_id: string | null
          promoted_company_id: string | null
          drive_folder_url: string | null
          notes_summary: string | null
          created_at: string
          updated_at: string
          created_by: string | null
        }
        Insert: {
          id?: string
          fund_id: string
          name: string
          aliases?: string[] | null
          sector?: string | null
          stage_at_consideration?: string | null
          deal_status?: string
          current_memo_stage?: string
          lead_partner_id?: string | null
          promoted_company_id?: string | null
          drive_folder_url?: string | null
          notes_summary?: string | null
          created_at?: string
          updated_at?: string
          created_by?: string | null
        }
        Update: {
          id?: string
          fund_id?: string
          name?: string
          aliases?: string[] | null
          sector?: string | null
          stage_at_consideration?: string | null
          deal_status?: string
          current_memo_stage?: string
          lead_partner_id?: string | null
          promoted_company_id?: string | null
          drive_folder_url?: string | null
          notes_summary?: string | null
          created_at?: string
          updated_at?: string
          created_by?: string | null
        }
        Relationships: []
      }
      diligence_documents: {
        Row: {
          id: string
          deal_id: string
          fund_id: string
          storage_path: string
          file_name: string
          file_format: string
          file_size_bytes: number | null
          detected_type: string | null
          type_confidence: string | null
          parse_status: string
          parse_notes: string | null
          drive_file_id: string | null
          drive_source_url: string | null
          uploaded_by: string | null
          uploaded_at: string
        }
        Insert: {
          id?: string
          deal_id: string
          fund_id: string
          storage_path: string
          file_name: string
          file_format: string
          file_size_bytes?: number | null
          detected_type?: string | null
          type_confidence?: string | null
          parse_status?: string
          parse_notes?: string | null
          drive_file_id?: string | null
          drive_source_url?: string | null
          uploaded_by?: string | null
          uploaded_at?: string
        }
        Update: {
          id?: string
          deal_id?: string
          fund_id?: string
          storage_path?: string
          file_name?: string
          file_format?: string
          file_size_bytes?: number | null
          detected_type?: string | null
          type_confidence?: string | null
          parse_status?: string
          parse_notes?: string | null
          drive_file_id?: string | null
          drive_source_url?: string | null
          uploaded_by?: string | null
          uploaded_at?: string
        }
        Relationships: []
      }
      diligence_memo_drafts: {
        Row: {
          id: string
          deal_id: string
          fund_id: string
          draft_version: string
          agent_version: string
          ai_provider: string | null
          ai_model: string | null
          ingestion_output: Json | null
          research_output: Json | null
          qa_answers: Json | null
          memo_draft_output: Json | null
          is_draft: boolean
          finalized_at: string | null
          finalized_by: string | null
          created_at: string
          created_by: string | null
        }
        Insert: {
          id?: string
          deal_id: string
          fund_id: string
          draft_version: string
          agent_version: string
          ai_provider?: string | null
          ai_model?: string | null
          ingestion_output?: Json | null
          research_output?: Json | null
          qa_answers?: Json | null
          memo_draft_output?: Json | null
          is_draft?: boolean
          finalized_at?: string | null
          finalized_by?: string | null
          created_at?: string
          created_by?: string | null
        }
        Update: {
          id?: string
          deal_id?: string
          fund_id?: string
          draft_version?: string
          agent_version?: string
          ai_provider?: string | null
          ai_model?: string | null
          ingestion_output?: Json | null
          research_output?: Json | null
          qa_answers?: Json | null
          memo_draft_output?: Json | null
          is_draft?: boolean
          finalized_at?: string | null
          finalized_by?: string | null
          created_at?: string
          created_by?: string | null
        }
        Relationships: []
      }
      diligence_attention_items: {
        Row: {
          id: string
          deal_id: string
          draft_id: string | null
          fund_id: string
          kind: string
          urgency: string
          body: string
          links: Json | null
          status: string
          resolution_note: string | null
          resolved_by: string | null
          resolved_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          deal_id: string
          draft_id?: string | null
          fund_id: string
          kind: string
          urgency: string
          body: string
          links?: Json | null
          status?: string
          resolution_note?: string | null
          resolved_by?: string | null
          resolved_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          deal_id?: string
          draft_id?: string | null
          fund_id?: string
          kind?: string
          urgency?: string
          body?: string
          links?: Json | null
          status?: string
          resolution_note?: string | null
          resolved_by?: string | null
          resolved_at?: string | null
          created_at?: string
        }
        Relationships: []
      }
      diligence_agent_sessions: {
        Row: {
          id: string
          deal_id: string
          fund_id: string
          stage: string | null
          title: string | null
          messages: Json
          ai_provider: string | null
          ai_model: string | null
          created_at: string
          updated_at: string
          created_by: string | null
        }
        Insert: {
          id?: string
          deal_id: string
          fund_id: string
          stage?: string | null
          title?: string | null
          messages?: Json
          ai_provider?: string | null
          ai_model?: string | null
          created_at?: string
          updated_at?: string
          created_by?: string | null
        }
        Update: {
          id?: string
          deal_id?: string
          fund_id?: string
          stage?: string | null
          title?: string | null
          messages?: Json
          ai_provider?: string | null
          ai_model?: string | null
          created_at?: string
          updated_at?: string
          created_by?: string | null
        }
        Relationships: []
      }
      memo_agent_jobs: {
        Row: {
          id: string
          fund_id: string
          deal_id: string
          draft_id: string | null
          kind: string
          status: string
          payload: Json | null
          result: Json | null
          progress_message: string | null
          error: string | null
          attempts: number
          enqueued_at: string
          started_at: string | null
          finished_at: string | null
          enqueued_by: string | null
          lock_version: number
          // Added by 20260519000000_call_transcripts.sql and missing from this file until now —
          // the generated types had drifted behind the schema.
          external_job_id: string | null
          // Added by 20260903120000_transcription_callback_tokens.sql (SEC-010).
          callback_token_hash: string | null
        }
        Insert: {
          id?: string
          fund_id: string
          deal_id: string
          draft_id?: string | null
          kind: string
          status?: string
          payload?: Json | null
          result?: Json | null
          progress_message?: string | null
          error?: string | null
          attempts?: number
          enqueued_at?: string
          started_at?: string | null
          finished_at?: string | null
          enqueued_by?: string | null
          lock_version?: number
          external_job_id?: string | null
          callback_token_hash?: string | null
        }
        Update: {
          id?: string
          fund_id?: string
          deal_id?: string
          draft_id?: string | null
          kind?: string
          status?: string
          payload?: Json | null
          result?: Json | null
          progress_message?: string | null
          error?: string | null
          attempts?: number
          enqueued_at?: string
          started_at?: string | null
          finished_at?: string | null
          enqueued_by?: string | null
          lock_version?: number
          external_job_id?: string | null
          callback_token_hash?: string | null
        }
        Relationships: []
      }
      diligence_notes: {
        Row: {
          id: string
          deal_id: string
          fund_id: string
          body: string
          author_id: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          deal_id: string
          fund_id: string
          body: string
          author_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          deal_id?: string
          fund_id?: string
          body?: string
          author_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      style_anchor_memos: {
        Row: {
          id: string
          fund_id: string
          storage_path: string
          file_name: string
          file_format: string
          file_size_bytes: number | null
          title: string | null
          anonymized: boolean
          vintage_year: number | null
          vintage_quarter: string | null
          sector: string | null
          deal_stage_at_writing: string | null
          outcome: string | null
          conviction_at_writing: string | null
          voice_representativeness: string
          authorship: string | null
          author_initials: string | null
          focus_attention_on: Json | null
          deprioritize_in_this_memo: Json | null
          partner_notes: string | null
          extracted_text: string | null
          extracted_at: string | null
          uploaded_by: string | null
          uploaded_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          fund_id: string
          storage_path: string
          file_name: string
          file_format: string
          file_size_bytes?: number | null
          title?: string | null
          anonymized?: boolean
          vintage_year?: number | null
          vintage_quarter?: string | null
          sector?: string | null
          deal_stage_at_writing?: string | null
          outcome?: string | null
          conviction_at_writing?: string | null
          voice_representativeness?: string
          authorship?: string | null
          author_initials?: string | null
          focus_attention_on?: Json | null
          deprioritize_in_this_memo?: Json | null
          partner_notes?: string | null
          extracted_text?: string | null
          extracted_at?: string | null
          uploaded_by?: string | null
          uploaded_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          fund_id?: string
          storage_path?: string
          file_name?: string
          file_format?: string
          file_size_bytes?: number | null
          title?: string | null
          anonymized?: boolean
          vintage_year?: number | null
          vintage_quarter?: string | null
          sector?: string | null
          deal_stage_at_writing?: string | null
          outcome?: string | null
          conviction_at_writing?: string | null
          voice_representativeness?: string
          authorship?: string | null
          author_initials?: string | null
          focus_attention_on?: Json | null
          deprioritize_in_this_memo?: Json | null
          partner_notes?: string | null
          extracted_text?: string | null
          extracted_at?: string | null
          uploaded_by?: string | null
          uploaded_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      funds: {
        Row: {
          address: string | null
          created_at: string | null
          created_by: string
          currency: string
          email_domain: string | null
          id: string
          logo_url: string | null
          name: string
          updated_at: string | null
        }
        Insert: {
          address?: string | null
          created_at?: string | null
          created_by: string
          currency?: string
          email_domain?: string | null
          id?: string
          logo_url?: string | null
          name: string
          updated_at?: string | null
        }
        Update: {
          address?: string | null
          created_at?: string | null
          created_by?: string
          currency?: string
          email_domain?: string | null
          id?: string
          logo_url?: string | null
          name?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      inbound_deals: {
        Row: {
          assigned_to: string | null
          co_founders: Json | null
          company_domain: string | null
          company_name: string | null
          company_summary: string | null
          company_url: string | null
          created_at: string | null
          email_id: string
          extracted_data: Json | null
          founder_email: string | null
          founder_name: string | null
          fund_id: string
          id: string
          industry: string | null
          intro_source: string | null
          prior_deal_id: string | null
          promoted_diligence_id: string | null
          raise_amount: string | null
          referrer_email: string | null
          referrer_name: string | null
          stage: string | null
          status: string
          thesis_fit_analysis: string | null
          thesis_fit_score: string | null
          updated_at: string | null
        }
        Insert: {
          assigned_to?: string | null
          co_founders?: Json | null
          company_domain?: string | null
          company_name?: string | null
          company_summary?: string | null
          company_url?: string | null
          created_at?: string | null
          email_id: string
          extracted_data?: Json | null
          founder_email?: string | null
          founder_name?: string | null
          fund_id: string
          id?: string
          industry?: string | null
          intro_source?: string | null
          prior_deal_id?: string | null
          promoted_diligence_id?: string | null
          raise_amount?: string | null
          referrer_email?: string | null
          referrer_name?: string | null
          stage?: string | null
          status?: string
          thesis_fit_analysis?: string | null
          thesis_fit_score?: string | null
          updated_at?: string | null
        }
        Update: {
          assigned_to?: string | null
          co_founders?: Json | null
          company_domain?: string | null
          company_name?: string | null
          company_summary?: string | null
          company_url?: string | null
          created_at?: string | null
          email_id?: string
          extracted_data?: Json | null
          founder_email?: string | null
          founder_name?: string | null
          fund_id?: string
          id?: string
          industry?: string | null
          intro_source?: string | null
          prior_deal_id?: string | null
          promoted_diligence_id?: string | null
          raise_amount?: string | null
          referrer_email?: string | null
          referrer_name?: string | null
          stage?: string | null
          status?: string
          thesis_fit_analysis?: string | null
          thesis_fit_score?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      known_referrers: {
        Row: {
          added_by: string | null
          created_at: string | null
          email: string
          fund_id: string
          id: string
          name: string | null
          notes: string | null
        }
        Insert: {
          added_by?: string | null
          created_at?: string | null
          email: string
          fund_id: string
          id?: string
          name?: string | null
          notes?: string | null
        }
        Update: {
          added_by?: string | null
          created_at?: string | null
          email?: string
          fund_id?: string
          id?: string
          name?: string | null
          notes?: string | null
        }
        Relationships: []
      }
      routing_corrections: {
        Row: {
          corrected_by: string | null
          corrected_label: string
          created_at: string | null
          email_id: string
          fund_id: string
          id: string
          original_label: string
        }
        Insert: {
          corrected_by?: string | null
          corrected_label: string
          created_at?: string | null
          email_id: string
          fund_id: string
          id?: string
          original_label: string
        }
        Update: {
          corrected_by?: string | null
          corrected_label?: string
          created_at?: string | null
          email_id?: string
          fund_id?: string
          id?: string
          original_label?: string
        }
        Relationships: []
      }
      inbound_emails: {
        Row: {
          attachments_count: number | null
          claude_response: Json | null
          company_id: string | null
          created_at: string | null
          email_type: string
          from_address: string
          fund_id: string
          id: string
          metrics_extracted: number | null
          processing_error: string | null
          processing_status: string | null
          raw_payload: Json | null
          received_at: string | null
          routed_to: string | null
          routing_confidence: number | null
          routing_label: string | null
          routing_reasoning: string | null
          routing_secondary_label: string | null
          subject: string | null
        }
        Insert: {
          attachments_count?: number | null
          claude_response?: Json | null
          company_id?: string | null
          created_at?: string | null
          email_type?: string
          from_address: string
          fund_id: string
          id?: string
          metrics_extracted?: number | null
          processing_error?: string | null
          processing_status?: string | null
          raw_payload?: Json | null
          received_at?: string | null
          routed_to?: string | null
          routing_confidence?: number | null
          routing_label?: string | null
          routing_reasoning?: string | null
          routing_secondary_label?: string | null
          subject?: string | null
        }
        Update: {
          attachments_count?: number | null
          claude_response?: Json | null
          company_id?: string | null
          created_at?: string | null
          email_type?: string
          from_address?: string
          fund_id?: string
          id?: string
          metrics_extracted?: number | null
          processing_error?: string | null
          processing_status?: string | null
          raw_payload?: Json | null
          received_at?: string | null
          routed_to?: string | null
          routing_confidence?: number | null
          routing_label?: string | null
          routing_reasoning?: string | null
          routing_secondary_label?: string | null
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inbound_emails_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_emails_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      interactions: {
        Row: {
          body_preview: string | null
          company_id: string | null
          created_at: string
          email_id: string | null
          fund_id: string
          id: string
          interaction_date: string
          intro_contacts: Json | null
          subject: string | null
          summary: string | null
          tags: string[]
          user_id: string
        }
        Insert: {
          body_preview?: string | null
          company_id?: string | null
          created_at?: string
          email_id?: string | null
          fund_id: string
          id?: string
          interaction_date?: string
          intro_contacts?: Json | null
          subject?: string | null
          summary?: string | null
          tags?: string[]
          user_id: string
        }
        Update: {
          body_preview?: string | null
          company_id?: string | null
          created_at?: string
          email_id?: string | null
          fund_id?: string
          id?: string
          interaction_date?: string
          intro_contacts?: Json | null
          subject?: string | null
          summary?: string | null
          tags?: string[]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "interactions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interactions_email_id_fkey"
            columns: ["email_id"]
            isOneToOne: true
            referencedRelation: "inbound_emails"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interactions_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      investment_transactions: {
        Row: {
          company_id: string
          converts_from_txn_id: string | null
          cost_basis_exited: number | null
          created_at: string | null
          current_share_price: number | null
          exit_valuation: number | null
          fund_id: string
          fx_rate: number | null
          fx_value_change: number | null
          id: string
          interest_converted: number | null
          investment_cost: number | null
          latest_postmoney_valuation: number | null
          notes: string | null
          original_currency: string | null
          original_current_share_price: number | null
          original_exit_valuation: number | null
          original_investment_cost: number | null
          original_latest_postmoney_valuation: number | null
          original_position_value: number | null
          original_postmoney_valuation: number | null
          original_proceeds_per_share: number | null
          original_proceeds_received: number | null
          original_share_price: number | null
          original_unrealized_value_change: number | null
          ownership_pct: number | null
          portfolio_group: string | null
          postmoney_valuation: number | null
          prior_fx_rate: number | null
          proceeds_escrow: number | null
          proceeds_per_share: number | null
          proceeds_received: number | null
          proceeds_written_off: number | null
          round_name: string | null
          security_type: string | null
          share_price: number | null
          shares_acquired: number | null
          transaction_date: string | null
          transaction_type: string
          unrealized_value_change: number | null
          updated_at: string | null
          valuation_change_source: string | null
        }
        Insert: {
          company_id: string
          converts_from_txn_id?: string | null
          cost_basis_exited?: number | null
          created_at?: string | null
          current_share_price?: number | null
          exit_valuation?: number | null
          fund_id: string
          fx_rate?: number | null
          fx_value_change?: number | null
          id?: string
          interest_converted?: number | null
          investment_cost?: number | null
          latest_postmoney_valuation?: number | null
          notes?: string | null
          original_currency?: string | null
          original_current_share_price?: number | null
          original_exit_valuation?: number | null
          original_investment_cost?: number | null
          original_latest_postmoney_valuation?: number | null
          original_position_value?: number | null
          original_postmoney_valuation?: number | null
          original_proceeds_per_share?: number | null
          original_proceeds_received?: number | null
          original_share_price?: number | null
          original_unrealized_value_change?: number | null
          ownership_pct?: number | null
          portfolio_group?: string | null
          postmoney_valuation?: number | null
          prior_fx_rate?: number | null
          proceeds_escrow?: number | null
          proceeds_per_share?: number | null
          proceeds_received?: number | null
          proceeds_written_off?: number | null
          round_name?: string | null
          security_type?: string | null
          share_price?: number | null
          shares_acquired?: number | null
          transaction_date?: string | null
          transaction_type: string
          unrealized_value_change?: number | null
          updated_at?: string | null
          valuation_change_source?: string | null
        }
        Update: {
          company_id?: string
          converts_from_txn_id?: string | null
          cost_basis_exited?: number | null
          created_at?: string | null
          current_share_price?: number | null
          exit_valuation?: number | null
          fund_id?: string
          fx_rate?: number | null
          fx_value_change?: number | null
          id?: string
          interest_converted?: number | null
          investment_cost?: number | null
          latest_postmoney_valuation?: number | null
          notes?: string | null
          original_currency?: string | null
          original_current_share_price?: number | null
          original_exit_valuation?: number | null
          original_investment_cost?: number | null
          original_latest_postmoney_valuation?: number | null
          original_position_value?: number | null
          original_postmoney_valuation?: number | null
          original_proceeds_per_share?: number | null
          original_proceeds_received?: number | null
          original_share_price?: number | null
          original_unrealized_value_change?: number | null
          ownership_pct?: number | null
          portfolio_group?: string | null
          postmoney_valuation?: number | null
          prior_fx_rate?: number | null
          proceeds_escrow?: number | null
          proceeds_per_share?: number | null
          proceeds_received?: number | null
          proceeds_written_off?: number | null
          round_name?: string | null
          security_type?: string | null
          share_price?: number | null
          shares_acquired?: number | null
          transaction_date?: string | null
          transaction_type?: string
          unrealized_value_change?: number | null
          updated_at?: string | null
          valuation_change_source?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "investment_transactions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "investment_transactions_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      lp_entities: {
        Row: {
          created_at: string | null
          entity_name: string
          fund_id: string
          id: string
          investor_id: string
        }
        Insert: {
          created_at?: string | null
          entity_name: string
          fund_id: string
          id?: string
          investor_id: string
        }
        Update: {
          created_at?: string | null
          entity_name?: string
          fund_id?: string
          id?: string
          investor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lp_entities_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lp_entities_investor_id_fkey"
            columns: ["investor_id"]
            isOneToOne: false
            referencedRelation: "lp_investors"
            referencedColumns: ["id"]
          },
        ]
      }
      lp_investments: {
        Row: {
          called_capital: number | null
          commitment: number | null
          created_at: string | null
          distributions: number | null
          dpi: number | null
          entity_id: string
          fund_id: string
          id: string
          irr: number | null
          nav: number | null
          outstanding_balance: number | null
          paid_in_capital: number | null
          portfolio_group: string
          rvpi: number | null
          snapshot_id: string | null
          total_value: number | null
          tvpi: number | null
          updated_at: string | null
        }
        Insert: {
          called_capital?: number | null
          commitment?: number | null
          created_at?: string | null
          distributions?: number | null
          dpi?: number | null
          entity_id: string
          fund_id: string
          id?: string
          irr?: number | null
          nav?: number | null
          outstanding_balance?: number | null
          paid_in_capital?: number | null
          portfolio_group: string
          rvpi?: number | null
          snapshot_id?: string | null
          total_value?: number | null
          tvpi?: number | null
          updated_at?: string | null
        }
        Update: {
          called_capital?: number | null
          commitment?: number | null
          created_at?: string | null
          distributions?: number | null
          dpi?: number | null
          entity_id?: string
          fund_id?: string
          id?: string
          irr?: number | null
          nav?: number | null
          outstanding_balance?: number | null
          paid_in_capital?: number | null
          portfolio_group?: string
          rvpi?: number | null
          snapshot_id?: string | null
          total_value?: number | null
          tvpi?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lp_investments_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "lp_entities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lp_investments_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lp_investments_snapshot_id_fkey"
            columns: ["snapshot_id"]
            isOneToOne: false
            referencedRelation: "lp_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      lp_investors: {
        Row: {
          created_at: string | null
          fund_id: string
          id: string
          name: string
          parent_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          fund_id: string
          id?: string
          name: string
          parent_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          fund_id?: string
          id?: string
          name?: string
          parent_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lp_investors_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lp_investors_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "lp_investors"
            referencedColumns: ["id"]
          },
        ]
      }
      lp_letter_templates: {
        Row: {
          created_at: string | null
          fund_id: string
          id: string
          is_default: boolean
          name: string
          source_filename: string | null
          source_format: string | null
          source_text: string | null
          source_type: string | null
          style_guide: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          fund_id: string
          id?: string
          is_default?: boolean
          name?: string
          source_filename?: string | null
          source_format?: string | null
          source_text?: string | null
          source_type?: string | null
          style_guide?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          fund_id?: string
          id?: string
          is_default?: boolean
          name?: string
          source_filename?: string | null
          source_format?: string | null
          source_text?: string | null
          source_type?: string | null
          style_guide?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lp_letter_templates_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      lp_letters: {
        Row: {
          company_narratives: Json | null
          company_prompts: Json | null
          created_at: string | null
          created_by: string | null
          full_draft: string | null
          fund_id: string
          generation_error: string | null
          generation_prompt: string | null
          id: string
          is_year_end: boolean
          period_label: string
          period_quarter: number
          period_year: number
          portfolio_group: string
          portfolio_summary: Json | null
          portfolio_table_html: string | null
          status: string
          template_id: string | null
          updated_at: string | null
        }
        Insert: {
          company_narratives?: Json | null
          company_prompts?: Json | null
          created_at?: string | null
          created_by?: string | null
          full_draft?: string | null
          fund_id: string
          generation_error?: string | null
          generation_prompt?: string | null
          id?: string
          is_year_end?: boolean
          period_label: string
          period_quarter: number
          period_year: number
          portfolio_group: string
          portfolio_summary?: Json | null
          portfolio_table_html?: string | null
          status?: string
          template_id?: string | null
          updated_at?: string | null
        }
        Update: {
          company_narratives?: Json | null
          company_prompts?: Json | null
          created_at?: string | null
          created_by?: string | null
          full_draft?: string | null
          fund_id?: string
          generation_error?: string | null
          generation_prompt?: string | null
          id?: string
          is_year_end?: boolean
          period_label?: string
          period_quarter?: number
          period_year?: number
          portfolio_group?: string
          portfolio_summary?: Json | null
          portfolio_table_html?: string | null
          status?: string
          template_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lp_letters_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lp_letters_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "lp_letter_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      lp_snapshots: {
        Row: {
          as_of_date: string | null
          created_at: string | null
          description: string | null
          fund_id: string
          id: string
          name: string
          updated_at: string | null
        }
        Insert: {
          as_of_date?: string | null
          created_at?: string | null
          description?: string | null
          fund_id: string
          id?: string
          name: string
          updated_at?: string | null
        }
        Update: {
          as_of_date?: string | null
          created_at?: string | null
          description?: string | null
          fund_id?: string
          id?: string
          name?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lp_snapshots_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      metric_values: {
        Row: {
          company_id: string
          confidence: string | null
          created_at: string | null
          fund_id: string
          id: string
          is_manually_entered: boolean | null
          metric_id: string
          notes: string | null
          period_label: string
          period_month: number | null
          period_quarter: number | null
          period_year: number
          source_email_id: string | null
          updated_at: string | null
          value_number: number | null
          value_text: string | null
        }
        Insert: {
          company_id: string
          confidence?: string | null
          created_at?: string | null
          fund_id: string
          id?: string
          is_manually_entered?: boolean | null
          metric_id: string
          notes?: string | null
          period_label: string
          period_month?: number | null
          period_quarter?: number | null
          period_year: number
          source_email_id?: string | null
          updated_at?: string | null
          value_number?: number | null
          value_text?: string | null
        }
        Update: {
          company_id?: string
          confidence?: string | null
          created_at?: string | null
          fund_id?: string
          id?: string
          is_manually_entered?: boolean | null
          metric_id?: string
          notes?: string | null
          period_label?: string
          period_month?: number | null
          period_quarter?: number | null
          period_year?: number
          source_email_id?: string | null
          updated_at?: string | null
          value_number?: number | null
          value_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "metric_values_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metric_values_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metric_values_metric_id_fkey"
            columns: ["metric_id"]
            isOneToOne: false
            referencedRelation: "metrics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metric_values_source_email_id_fkey"
            columns: ["source_email_id"]
            isOneToOne: false
            referencedRelation: "inbound_emails"
            referencedColumns: ["id"]
          },
        ]
      }
      metrics: {
        Row: {
          company_id: string
          created_at: string | null
          currency: string | null
          description: string | null
          display_order: number | null
          fund_id: string
          id: string
          is_active: boolean | null
          name: string
          reporting_cadence: string | null
          slug: string
          unit: string | null
          unit_position: string | null
          value_type: string | null
        }
        Insert: {
          company_id: string
          created_at?: string | null
          currency?: string | null
          description?: string | null
          display_order?: number | null
          fund_id: string
          id?: string
          is_active?: boolean | null
          name: string
          reporting_cadence?: string | null
          slug: string
          unit?: string | null
          unit_position?: string | null
          value_type?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string | null
          currency?: string | null
          description?: string | null
          display_order?: number | null
          fund_id?: string
          id?: string
          is_active?: boolean | null
          name?: string
          reporting_cadence?: string | null
          slug?: string
          unit?: string | null
          unit_position?: string | null
          value_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "metrics_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "metrics_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      note_company_subscriptions: {
        Row: {
          company_id: string
          created_at: string
          fund_id: string
          id: string
          user_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          fund_id: string
          id?: string
          user_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          fund_id?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_company_subscriptions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "note_company_subscriptions_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      note_notification_preferences: {
        Row: {
          created_at: string
          fund_id: string
          id: string
          level: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          fund_id: string
          id?: string
          level?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          fund_id?: string
          id?: string
          level?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_notification_preferences_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      note_reads: {
        Row: {
          note_id: string
          read_at: string
          user_id: string
        }
        Insert: {
          note_id: string
          read_at?: string
          user_id: string
        }
        Update: {
          note_id?: string
          read_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_reads_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "company_notes"
            referencedColumns: ["id"]
          },
        ]
      }
      parsing_reviews: {
        Row: {
          company_id: string | null
          context_snippet: string | null
          created_at: string | null
          email_id: string
          extracted_value: string | null
          fund_id: string
          id: string
          issue_type: string
          metric_id: string | null
          payload: Json | null
          resolution: string | null
          resolved_at: string | null
          resolved_value: string | null
          vehicle_id: string | null
        }
        Insert: {
          company_id?: string | null
          context_snippet?: string | null
          created_at?: string | null
          email_id: string
          extracted_value?: string | null
          fund_id: string
          id?: string
          issue_type: string
          metric_id?: string | null
          payload?: Json | null
          resolution?: string | null
          resolved_at?: string | null
          resolved_value?: string | null
          vehicle_id?: string | null
        }
        Update: {
          company_id?: string | null
          context_snippet?: string | null
          created_at?: string | null
          email_id?: string
          extracted_value?: string | null
          fund_id?: string
          id?: string
          issue_type?: string
          metric_id?: string | null
          payload?: Json | null
          resolution?: string | null
          resolved_at?: string | null
          resolved_value?: string | null
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "parsing_reviews_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parsing_reviews_email_id_fkey"
            columns: ["email_id"]
            isOneToOne: false
            referencedRelation: "inbound_emails"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parsing_reviews_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parsing_reviews_metric_id_fkey"
            columns: ["metric_id"]
            isOneToOne: false
            referencedRelation: "metrics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parsing_reviews_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "fund_vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_group_metrics: {
        Row: {
          created_at: string | null
          dpi: number | null
          fund_id: string
          id: string
          net_irr: number | null
          portfolio_group: string
          report_date: string
          rvpi: number | null
          tvpi: number | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          dpi?: number | null
          fund_id: string
          id?: string
          net_irr?: number | null
          portfolio_group: string
          report_date: string
          rvpi?: number | null
          tvpi?: number | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          dpi?: number | null
          fund_id?: string
          id?: string
          net_irr?: number | null
          portfolio_group?: string
          report_date?: string
          rvpi?: number | null
          tvpi?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "portfolio_group_metrics_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_entries: {
        Row: {
          created_at: string
          id: string
          key: string
        }
        Insert: {
          created_at?: string
          id?: string
          key: string
        }
        Update: {
          created_at?: string
          id?: string
          key?: string
        }
        Relationships: []
      }
      user_activity_logs: {
        Row: {
          action: string
          created_at: string
          fund_id: string
          id: string
          metadata: Json | null
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string
          fund_id: string
          id?: string
          metadata?: Json | null
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string
          fund_id?: string
          id?: string
          metadata?: Json | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_activity_logs_fund_id_fkey"
            columns: ["fund_id"]
            isOneToOne: false
            referencedRelation: "funds"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      count_unread_notes: { Args: { p_user_id: string }; Returns: number }
      get_my_fund_ids: { Args: never; Returns: string[] }
      hook_before_user_created: { Args: { event: Json }; Returns: Json }
      is_fund_admin: { Args: { check_fund_id: string }; Returns: boolean }
      is_fund_member_by_email: {
        Args: { p_email: string; p_fund_id: string }
        Returns: {
          member_role: string
          user_id: string
        }[]
      }
      is_fund_writer: { Args: { check_fund_id: string }; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const

// Row-level type aliases
export type AppSettings    = Tables<'app_settings'>
export type Fund           = Tables<'funds'>
export type FundMember     = Tables<'fund_members'>
export type FundSettings   = Tables<'fund_settings'>
export type AuthorizedSender = Tables<'authorized_senders'>
export type Company        = Tables<'companies'>
export type InboundEmail   = Tables<'inbound_emails'>
export type Metric         = Tables<'metrics'>
export type MetricValue    = Tables<'metric_values'>
export type CompanySummary = Tables<'company_summaries'>
export type ParsingReview  = Tables<'parsing_reviews'>
export type AllowedSignup  = Tables<'allowed_signups'>
export type FundJoinRequest = Tables<'fund_join_requests'>
export type EmailRequest    = Tables<'email_requests'>
export type CompanyNote     = Tables<'company_notes'>
export type InvestmentTransaction = Tables<'investment_transactions'>
export type NoteRead             = Tables<'note_reads'>
export type NoteNotificationPreference = Tables<'note_notification_preferences'>
export type NoteCompanySubscription    = Tables<'note_company_subscriptions'>
export type AnalystConversation        = Tables<'analyst_conversations'>
export type Interaction                = Tables<'interactions'>
export type LpLetterTemplate           = Tables<'lp_letter_templates'>
export type LpLetter                   = Tables<'lp_letters'>
export type CompanyUpdate              = Tables<'company_updates'>
export type CompanyUpdateArtifact      = Tables<'company_update_artifacts'>
export type CompanyUpdateChunk         = Tables<'company_update_chunks'>

export interface CompanyNarrative {
  company_id: string
  company_name: string
  narrative: string
  updated_by: string | null
  updated_at: string
}

export type LpLetterStatus = 'generating' | 'draft' | 'final'

// Enum-style string literals
export type CompanyStatus      = 'active' | 'exited' | 'written-off'
export type ProcessingStatus   = 'pending' | 'processing' | 'success' | 'failed' | 'needs_review' | 'not_processed'
export type Confidence         = 'high' | 'medium' | 'low'
export type ValueType          = 'number' | 'currency' | 'percentage' | 'text'
export type UnitPosition       = 'prefix' | 'suffix'
export type ReportingCadence   = 'quarterly' | 'monthly' | 'annual'
export type IssueType          =
  | 'new_company_detected'
  | 'low_confidence'
  | 'ambiguous_period'
  | 'metric_not_found'
  | 'company_not_identified'
  | 'duplicate_period'
  | 'deal_extraction'
  | 'routing_low_confidence'
  | 'multi_company_email'
  | 'diligence_intake_pending'
  | 'fund_nav'
  | 'fund_capital_call'
  | 'fund_distribution'

// 'deals' = a company pitching us (screening / dealflow → inbound_deals).
// 'diligence' = an email about a company ALREADY in diligence; it is proposed
// for that deal's data room and imported only once a human accepts it.
export type RoutingLabel       = 'reporting' | 'interactions' | 'deals' | 'diligence' | 'other'
export type RoutedTo           = 'reporting' | 'interactions' | 'deals' | 'diligence' | 'audit' | 'review'
export type DiligenceIntakeStatus = 'pending' | 'accepted' | 'rejected'
export type ThesisFitScore     = 'strong' | 'moderate' | 'weak' | 'out_of_thesis' | 'spam'
export type DealStatus         = 'new' | 'reviewing' | 'advancing' | 'met' | 'diligence' | 'invested' | 'passed'
// 'heartbeat' is a historical value: it was set only by the now-removed Heartbeat
// integration and is kept here so existing inbound_deals rows with
// intro_source='heartbeat' remain valid. It is deliberately absent from
// VALID_INTRO_SOURCES in lib/claude/analyzeDeal.ts so the model can't label an
// emailed pitch as having come from the community, and it can no longer be set
// on new rows.
export type IntroSource        = 'referral' | 'cold' | 'warm_intro' | 'accelerator' | 'demo_day' | 'event' | 'heartbeat' | 'other'
export type ReviewResolution   = 'accepted' | 'rejected' | 'manually_corrected'
export type EmailRequestStatus = 'draft' | 'sent' | 'failed'
export type TransactionType    = 'investment' | 'proceeds' | 'escrow_receipt' | 'unrealized_gain_change' | 'round_info'
export type NotificationLevel  = 'all' | 'mentions' | 'none'
