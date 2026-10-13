alter table edit_proposals
  drop constraint edit_proposals_generator_check;

alter table edit_proposals
  add constraint edit_proposals_generator_check
  check (generator in ('claude', 'gemini', 'offline_rules'));
