import type { Status } from '../../../src/types';

/**
 * The status-change event shape, shared by the API Lambda (producer), the
 * batcher (writer), and the Glue table definition (reader). One flat record
 * per transition — flat because Athena's JSON SerDe maps top-level keys to
 * columns with zero configuration.
 */
export interface StatusChangeEvent {
  /** Random id so at-least-once delivery can be deduplicated downstream. */
  event_id: string;
  user_id: string;
  app_id: string;
  company: string;
  source: string;
  status: Status;
  prev_status: Status | null;
  /** ISO timestamp of the transition. */
  at: string;
  /** yyyy-mm-dd the application was sent, '' when unknown. */
  applied_date: string;
}

export const EVENT_SOURCE = 'callback.api';
export const EVENT_DETAIL_TYPE = 'application.status-changed';
