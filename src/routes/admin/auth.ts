import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";

declare module "fastify" {
  interface Session {
    adminId?: string;
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.session.adminId) {
    reply.code(401).send({ error: "Not authenticated" });
    return;
  }
}

const authRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: { email: string; password: string } }>("/admin/api/login", async (request, reply) => {
    const { email, password } = request.body;
    const { rows } = await app.pg.query("SELECT * FROM reseller_admin_users WHERE email = $1", [email]);
    if (rows.length === 0) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    request.session.adminId = rows[0].id;
    return { ok: true };
  });

  app.post("/admin/api/logout", async (request) => {
    await request.session.destroy();
    return { ok: true };
  });

  app.get("/admin/api/me", { preHandler: requireAdmin }, async (request) => {
    return { adminId: request.session.adminId };
  });
};

export default authRoutes;
