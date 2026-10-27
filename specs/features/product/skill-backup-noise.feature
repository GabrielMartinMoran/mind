@product/skill-backup-noise
Feature: Skill installation leaves no backup noise in discovery paths

  Mind replaces the managed mind-management skill without leaving persistent
  SKILL.md or skill-directory backups that agents can discover. Ancestor repair
  and agent-config backups keep their existing safety behavior.

  Background:
    Given a temporary home directory

  Rule: Managed skill updates leave no backups in skill discovery paths

    @unit
    Scenario: Updating an outdated canonical skill leaves no backup
      Given an outdated canonical mind-management skill
      When setup installs the current canonical skill
      Then the canonical SKILL.md is updated
      And no SKILL.md.bak artifact exists in the canonical skill directory
      And no mind-management.bak directory exists in the skills root

    @unit
    Scenario: Updating a marked skill leaves no backup
      Given a marked mind-management skill with different content
      When setup installs the current canonical skill
      Then the skill content is updated
      And no backup artifact is created

    @unit
    Scenario: An identical skill creates no artifact
      Given an already current canonical mind-management skill
      When setup runs again
      Then the skill remains byte-identical
      And no backup artifact is created

    @integration
    Scenario: Migrating a legacy OpenCode shadow leaves no discoverable backup
      Given a legacy OpenCode shadow skill with SKILL.md and notes.md
      When setup opencode installs the canonical skill
      Then the shadow SKILL.md is removed
      And notes.md is preserved
      And no mind-management.bak directory exists under the OpenCode skills root
      And no SKILL.md.bak artifact exists in the canonical skill directory

    @unit
    Scenario: Replacing a dedicated client copy leaves no backup
      Given a dedicated client skill copy with different content
      When setup links or copies the canonical skill
      Then the dedicated path resolves to the current canonical skill
      And no backup artifact is created

    @unit
    Scenario: Auxiliary files survive without a SKILL.md backup
      Given a managed client skill directory with extra files
      When setup replaces SKILL.md
      Then the extra files remain
      And no SKILL.md.bak artifact is created

  Rule: Foreign skills and symlink safety are preserved

    @unit
    Scenario: A sibling foreign skill is never modified
      Given another skill in the same skills root
      When setup installs mind-management
      Then the sibling skill is byte-identical
      And no backup is created beside it

    @unit
    Scenario: A foreign canonical symlink is replaced without following it
      Given a canonical skill path that is a symlink to an external directory
      When setup installs the canonical skill
      Then the external target is unchanged
      And the canonical path is a real directory
      And the warning names the old target
      And no backup sidecar is created

    @unit
    Scenario: A broken symlink is repaired without a backup
      Given a broken symlink at the canonical skill path
      When setup installs the canonical skill
      Then the canonical skill is installed
      And no backup sidecar is created

    @unit
    Scenario: A file-level SKILL.md symlink is replaced without touching its target
      Given a canonical directory whose SKILL.md is a symlink
      When setup installs the canonical skill
      Then the external target is unchanged
      And SKILL.md is replaced by a regular file
      And no SKILL.md.bak artifact is created

  Rule: Safety repairs outside skill paths are unchanged

    @unit
    Scenario: A blocking ancestor file is still backed up
      Given a file where the ~/.agents directory must be created
      When setup repairs the ancestor path
      Then the blocking file is preserved in a timestamped sibling backup
      And the skill root is created

    @integration
    Scenario: Agent config backups remain separate
      Given an existing OpenCode config
      When setup updates the OpenCode configuration
      Then the previous config is preserved in a timestamped backup
      And no skill backup is created

  Rule: Historical backups are not silently deleted

    @unit
    Scenario: Pre-existing skill backups are left for manual cleanup
      Given a pre-existing mind-management.bak directory
      When setup installs the current skill
      Then the new installation leaves no additional backup
      And the pre-existing backup is not automatically deleted
