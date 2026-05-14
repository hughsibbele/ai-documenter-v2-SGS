export type RosterEntry = {
  canvas_user_id: string;
  email: string;
  display_name: string;
  anon_token: string;
};

export type Roster = readonly RosterEntry[];
