import { BadRequestException } from '@nestjs/common';
import { AdminController } from './admin.controller';

/**
 * Who this panel may promote, and to what.
 *
 * The endpoint took `body.role` and passed it straight to the repository. No
 * check on the value, and SUPER_ADMIN offered like any other option in a
 * dropdown on every row of the user table.
 *
 * Two different failures shared that one line. An unchecked string reaches the
 * column, and every role comparison in the panel then silently stops matching
 * for that account. And super admin - total control of settings, pricing and
 * every account's credits - was a misclick away for anybody holding an
 * ordinary admin session.
 */

function controller() {
  const userRepo = { setRole: jest.fn().mockResolvedValue(undefined) };

  // Only userRepo is exercised; the rest of the constructor is irrelevant here
  // and passing undefined keeps this a unit test rather than a wiring test.
  const instance = Object.create(AdminController.prototype) as AdminController;
  Object.assign(instance, { userRepo });

  return { instance, userRepo };
}

describe('changing a role', () => {
  it.each(['GUEST_LAWYER', 'VERIFIED_ADVOCATE', 'LEGAL_AUDITOR'])('allows %s', async (role) => {
    const { instance, userRepo } = controller();

    await expect(instance.setRole('u1', { role })).resolves.toEqual({ updated: true, role });
    expect(userRepo.setRole).toHaveBeenCalledWith('u1', role);
  });

  it('refuses to grant super admin', async () => {
    // The panel is not where this happens. Promotion to super admin is a
    // deliberate act with an audit trail behind it, not a select element.
    const { instance, userRepo } = controller();

    await expect(instance.setRole('u1', { role: 'SUPER_ADMIN' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(userRepo.setRole).not.toHaveBeenCalled();
  });

  it('refuses it however it is spelled', async () => {
    // The UI is a reminder, not the guard - anybody can POST this directly.
    const { instance, userRepo } = controller();

    await expect(instance.setRole('u1', { role: ' super_admin ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(userRepo.setRole).not.toHaveBeenCalled();
  });

  it.each(['', 'ADMIN', 'GUEST-LAWYER', 'undefined'])('refuses %p', async (role) => {
    /*
     * The value was never validated, so a typo reached the column. Nothing
     * fails loudly at that point: the write succeeds, and every guard in the
     * panel quietly stops matching for that account, which then loses features
     * nobody can see it should have.
     */
    const { instance, userRepo } = controller();

    await expect(instance.setRole('u1', { role })).rejects.toBeInstanceOf(BadRequestException);
    expect(userRepo.setRole).not.toHaveBeenCalled();
  });

  it('refuses a missing body', async () => {
    const { instance } = controller();

    await expect(instance.setRole('u1', {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still allows demoting a super admin', async () => {
    // Removing an administrator who should no longer be one is the urgent
    // direction, and refusing it would be the wrong failure.
    const { instance, userRepo } = controller();

    await expect(instance.setRole('u1', { role: 'GUEST_LAWYER' })).resolves.toMatchObject({
      updated: true,
    });
    expect(userRepo.setRole).toHaveBeenCalledWith('u1', 'GUEST_LAWYER');
  });
});
