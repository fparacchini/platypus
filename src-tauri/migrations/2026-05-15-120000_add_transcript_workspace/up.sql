ALTER TABLE projects_activities
ADD COLUMN transcript_raw_json TEXT NOT NULL DEFAULT '';

ALTER TABLE projects_activities
ADD COLUMN transcript_polished_text TEXT NOT NULL DEFAULT '';

ALTER TABLE projects_activities
ADD COLUMN transcript_metadata_json TEXT NOT NULL DEFAULT '';
