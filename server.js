require("dotenv").config();

const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const multer = require("multer");
const PDFDocument = require("pdfkit");

const app = express();
const port = process.env.PORT || 3000;
const backendUrl = process.env.BACKEND_URL;
const bcvRateCacheTtlMs = 15 * 60 * 1000;
let bcvRateCache = null;
let bcvRateRefreshPromise = null;
const database = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
const paymentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter(request, file, callback) {
    const supportedTypes = ["image/jpeg", "image/png", "application/pdf"];
    callback(null, supportedTypes.includes(file.mimetype));
  },
});
const planImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(request, file, callback) {
    if (!["image/jpeg", "image/png"].includes(file.mimetype)) {
      callback(new Error("La imagen debe ser JPG o PNG."));
      return;
    }
    callback(null, true);
  },
});
const customerEnrollmentProofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter(request, file, callback) {
    if (!["image/jpeg", "image/png"].includes(file.mimetype)) {
      callback(new Error("El comprobante debe ser una imagen JPG o PNG."));
      return;
    }
    callback(null, true);
  },
});
const defaultPaymentPlans = {
  "Plan Diurno": {
    description: "Entrena durante el día y disfruta de más energía, mejor ánimo y un descanso de calidad.",
    benefits: [
      "Más energía y productividad para el día a día",
      "Ayuda a reducir el estrés y mejorar el estado de ánimo",
      "Mejora la calidad del sueño y el descanso nocturno",
    ],
    image: "img plan diurno.jpeg",
    enrollmentFee: 0,
    membershipFee: 50,
    period: "Mensualidad",
  },
  "Plan Parejas": {
    description: "Comparte tus entrenamientos, motívense mutuamente y avancen juntos hacia una vida más saludable.",
    benefits: [
      "Motivación mutua y mayor compromiso",
      "Mejora la comunicación y el trabajo en equipo",
      "Favorece la salud general y la calidad de vida",
    ],
    image: "img plan parejas.jpeg",
    enrollmentFee: 0,
    membershipFee: 80,
    period: "Mensualidad",
  },
  "Plan Semanal": {
    description: "Una opción flexible para entrenar durante una semana y enfocarte en tu fuerza y rendimiento.",
    benefits: [
      "Aumenta la fuerza y la masa muscular",
      "Mejora la resistencia y el rendimiento físico",
      "Disciplina, enfoque y resultados reales",
    ],
    image: "img plan semanal (2).jpeg",
    enrollmentFee: 0,
    membershipFee: 15,
    period: "Semana",
  },
  "Plan Estudiantil": {
    description: "Una alternativa para estudiantes de hasta 25 años: más energía, concentración y bienestar.",
    benefits: [
      "Mejora la concentración y el rendimiento académico",
      "Ayuda a reducir el estrés y la ansiedad",
      "Aumenta la energía y la autoestima",
    ],
    image: "img plan estudiantil.jpeg",
    enrollmentFee: 20,
    membershipFee: 30,
    period: "Mensualidad",
  },
  "Plan Kids": {
    description: "Actividad física adaptada para niños y niñas de 6 a 12 años, con supervisión profesional.",
    benefits: [
      "Entrenamiento adaptado a su edad",
      "Desarrolla fuerza y coordinación",
      "Mejora la condición física y la salud",
      "Fomenta disciplina, confianza y trabajo en equipo",
      "Supervisión profesional",
    ],
    image: "img plan kids.jpeg",
    enrollmentFee: 15,
    membershipFee: 15,
    period: "Mensualidad",
  },
  "Plan Full Time": {
    description: "Entrena con amplitud de horario y trabaja tu fuerza, resistencia y constancia.",
    benefits: [
      "Aumenta la fuerza y la masa muscular",
      "Mejora la resistencia y el rendimiento físico",
      "Disciplina, enfoque y resultados reales",
    ],
    image: "img full time.jpeg",
    enrollmentFee: 30,
    membershipFee: 50,
    period: "Mensualidad",
  },
};
let usersTableReady;
let paymentsTableReady;
let registeredCustomersTableReady;
let membershipTrackingTableReady;
let plansTableReady;
let paymentSettingsTableReady;
let membershipReminderCheckRunning = false;
const adminLoginAttempts = new Map();
const customerLoginAttempts = new Map();
const defaultPaymentSettings = {
  bankName: "Bancamiga",
  bankCode: "0172",
  documentId: "19532467",
  phone: "04241777587",
};

function getImageSignature(mimeType, buffer) {
  if (mimeType === "image/jpeg" && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return true;
  if (mimeType === "image/png"
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  return false;
}

async function ensurePlansTable() {
  if (!plansTableReady) {
    plansTableReady = (async () => {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        await client.query(`
          CREATE TABLE IF NOT EXISTS gym_payment_plans (
            id BIGSERIAL PRIMARY KEY,
            name VARCHAR(40) NOT NULL UNIQUE,
            enrollment_fee NUMERIC(10, 2) NOT NULL CHECK (enrollment_fee >= 0),
            membership_fee NUMERIC(10, 2) NOT NULL CHECK (membership_fee > 0),
            period VARCHAR(20) NOT NULL,
            description VARCHAR(500) NOT NULL DEFAULT '',
            benefits TEXT NOT NULL DEFAULT '',
            image_name VARCHAR(255) NOT NULL,
            image_mime_type VARCHAR(40) NOT NULL CHECK (image_mime_type IN ('image/jpeg', 'image/png')),
            image_data BYTEA NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await client.query(`
          ALTER TABLE gym_payment_plans
          ADD COLUMN IF NOT EXISTS description VARCHAR(500) NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS benefits TEXT NOT NULL DEFAULT ''
        `);
        for (const [name, plan] of Object.entries(defaultPaymentPlans)) {
          await client.query(`
            UPDATE gym_payment_plans
            SET description = $1
            WHERE name = $2 AND description = ''
          `, [plan.description, name]);
          await client.query(`
            UPDATE gym_payment_plans
            SET benefits = $1
            WHERE name = $2 AND benefits = ''
          `, [plan.benefits.join("\n"), name]);
        }
        await client.query(`
          CREATE TABLE IF NOT EXISTS gym_payment_plan_seed_state (
            id SMALLINT PRIMARY KEY CHECK (id = 1)
          )
        `);
        const seedState = await client.query(`
          SELECT id FROM gym_payment_plan_seed_state WHERE id = 1
        `);
        if (!seedState.rowCount) {
          for (const [name, plan] of Object.entries(defaultPaymentPlans)) {
            const imagePath = path.join(__dirname, "images_planes", plan.image);
            const imageData = await fs.promises.readFile(imagePath);
            const imageMimeType = plan.image.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
            await client.query(`
              INSERT INTO gym_payment_plans (
                name, enrollment_fee, membership_fee, period, description, benefits,
                image_name, image_mime_type, image_data
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
              ON CONFLICT (name) DO NOTHING
            `, [
              name,
              plan.enrollmentFee,
              plan.membershipFee,
              plan.period,
              plan.description,
              plan.benefits.join("\n"),
              plan.image,
              imageMimeType,
              imageData,
            ]);
          }
          await client.query("INSERT INTO gym_payment_plan_seed_state (id) VALUES (1) ON CONFLICT DO NOTHING");
        }
        await client.query("COMMIT");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error("No se pudo revertir la inicialización de los planes:", rollbackError);
        }
        throw error;
      } finally {
        client.release();
      }
    })().catch((error) => {
      plansTableReady = undefined;
      throw error;
    });
  }

  await plansTableReady;
}

async function getPaymentPlans() {
  await ensurePlansTable();
  const result = await database.query(`
    SELECT id, name, enrollment_fee, membership_fee, period, description, benefits, image_name, image_mime_type
    FROM gym_payment_plans
    ORDER BY id
  `);
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    enrollmentFee: Number(row.enrollment_fee),
    membershipFee: Number(row.membership_fee),
    period: row.period,
    description: row.description,
    benefits: row.benefits.split("\n").filter(Boolean),
    image: row.image_name,
    imageMimeType: row.image_mime_type,
  }));
}

async function getPaymentPlanByName(name) {
  await ensurePlansTable();
  const result = await database.query(`
    SELECT id, name, enrollment_fee, membership_fee, period, description, benefits,
      image_name, image_mime_type, image_data
    FROM gym_payment_plans
    WHERE name = $1
  `, [name]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    enrollmentFee: Number(row.enrollment_fee),
    membershipFee: Number(row.membership_fee),
    period: row.period,
    description: row.description,
    benefits: row.benefits.split("\n").filter(Boolean),
    image: row.image_name,
    imageMimeType: row.image_mime_type,
    imageData: row.image_data,
  };
}

async function ensurePaymentSettingsTable() {
  if (!paymentSettingsTableReady) {
    paymentSettingsTableReady = database.query(`
      CREATE TABLE IF NOT EXISTS gym_payment_settings (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        bank_name VARCHAR(80) NOT NULL,
        bank_code VARCHAR(4) NOT NULL,
        document_id VARCHAR(20) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).then(() => database.query(`
      INSERT INTO gym_payment_settings (id, bank_name, bank_code, document_id, phone)
      VALUES (1, $1, $2, $3, $4)
      ON CONFLICT (id) DO NOTHING
    `, [
      defaultPaymentSettings.bankName,
      defaultPaymentSettings.bankCode,
      defaultPaymentSettings.documentId,
      defaultPaymentSettings.phone,
    ])).catch((error) => {
      paymentSettingsTableReady = undefined;
      throw error;
    });
  }

  await paymentSettingsTableReady;
}

async function getPaymentSettings() {
  await ensurePaymentSettingsTable();
  const result = await database.query(`
    SELECT bank_name, bank_code, document_id, phone
    FROM gym_payment_settings
    WHERE id = 1
  `);
  const row = result.rows[0];
  if (!row) throw new Error("No se encontró la configuración de Pago Móvil.");
  return {
    bankName: row.bank_name,
    bankCode: row.bank_code,
    documentId: row.document_id,
    phone: row.phone,
  };
}

async function ensurePaymentsTable() {
  if (!paymentsTableReady) {
    paymentsTableReady = database.query(`
      CREATE TABLE IF NOT EXISTS gym_payment_submissions (
        id BIGSERIAL PRIMARY KEY,
        customer_name VARCHAR(100) NOT NULL,
        customer_email VARCHAR(254) NOT NULL,
        customer_phone VARCHAR(20) NOT NULL,
        payment_date DATE NOT NULL,
        plan_name VARCHAR(255) NOT NULL,
        payment_type VARCHAR(20) NOT NULL DEFAULT 'enrollment',
        plan_details JSONB,
        enrollment_fee NUMERIC(10, 2),
        membership_fee NUMERIC(10, 2),
        plan_period VARCHAR(20),
        plan_image_name VARCHAR(255),
        plan_image_mime_type VARCHAR(40),
        plan_image_data BYTEA,
        payment_method VARCHAR(40) NOT NULL DEFAULT 'Pago Móvil',
        receipt_name VARCHAR(255) NOT NULL,
        receipt_mime_type VARCHAR(40) NOT NULL,
        receipt_data BYTEA NOT NULL,
        status VARCHAR(12) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'approved')),
        submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        approved_at TIMESTAMPTZ
      )
    `).then(() => database.query(`
      ALTER TABLE gym_payment_submissions
      ADD COLUMN IF NOT EXISTS payment_method VARCHAR(40) NOT NULL DEFAULT 'Pago Móvil'
    `)).then(() => database.query(`
      ALTER TABLE gym_payment_submissions
      ADD COLUMN IF NOT EXISTS payment_type VARCHAR(20) NOT NULL DEFAULT 'enrollment'
    `)).then(() => database.query(`
      ALTER TABLE gym_payment_submissions
      ALTER COLUMN plan_name TYPE VARCHAR(255),
      ADD COLUMN IF NOT EXISTS plan_details JSONB
    `)).then(() => database.query(`
      ALTER TABLE gym_payment_submissions
      ADD COLUMN IF NOT EXISTS enrollment_fee NUMERIC(10, 2),
      ADD COLUMN IF NOT EXISTS membership_fee NUMERIC(10, 2),
      ADD COLUMN IF NOT EXISTS plan_period VARCHAR(20),
      ADD COLUMN IF NOT EXISTS plan_image_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS plan_image_mime_type VARCHAR(40),
      ADD COLUMN IF NOT EXISTS plan_image_data BYTEA
    `)).then(() => database.query(`
      CREATE INDEX IF NOT EXISTS gym_payment_submissions_status_submitted_idx
      ON gym_payment_submissions (status, submitted_at DESC)
    `)).catch((error) => {
      paymentsTableReady = undefined;
      throw error;
    });
  }

  await paymentsTableReady;
}

async function ensureRegisteredCustomersTable() {
  await ensurePaymentsTable();
  if (!registeredCustomersTableReady) {
    registeredCustomersTableReady = database.query(`
      CREATE TABLE IF NOT EXISTS gym_registered_customers (
        id BIGSERIAL PRIMARY KEY,
        customer_email VARCHAR(254) UNIQUE,
        customer_name VARCHAR(100) NOT NULL,
        enrollment_date DATE NOT NULL,
        customer_phone VARCHAR(20),
        plan_name VARCHAR(40),
        customer_password_hash TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).then(() => database.query(`
      ALTER TABLE gym_registered_customers
      ALTER COLUMN customer_email DROP NOT NULL,
      ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(20),
      ADD COLUMN IF NOT EXISTS plan_name VARCHAR(40),
      ADD COLUMN IF NOT EXISTS customer_password_hash TEXT,
      ADD COLUMN IF NOT EXISTS enrollment_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS enrollment_proof_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS enrollment_proof_mime_type VARCHAR(40),
      ADD COLUMN IF NOT EXISTS enrollment_proof_data BYTEA
    `)).then(async () => {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        await client.query(`
          CREATE TABLE IF NOT EXISTS gym_registered_customers_migrations (
            migration_name VARCHAR(100) PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        const migration = await client.query(`
          INSERT INTO gym_registered_customers_migrations (migration_name)
          VALUES ('replace_existing_customers_with_admin_registrations')
          ON CONFLICT (migration_name) DO NOTHING
          RETURNING migration_name
        `);
        if (migration.rowCount) {
          await client.query("DELETE FROM gym_registered_customers WHERE customer_email IS NOT NULL");
        }
        await client.query("COMMIT");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error("No se pudo revertir la limpieza de clientes registrados:", rollbackError);
        }
        throw error;
      } finally {
        client.release();
      }
    }).catch((error) => {
      registeredCustomersTableReady = undefined;
      throw error;
    });
  }

  await registeredCustomersTableReady;
}

async function ensureMembershipTrackingTable() {
  await ensureRegisteredCustomersTable();
  if (!membershipTrackingTableReady) {
    membershipTrackingTableReady = database.query(`
      CREATE TABLE IF NOT EXISTS gym_membership_tracking (
        id BIGSERIAL PRIMARY KEY,
        customer_name VARCHAR(100) NOT NULL,
        customer_email VARCHAR(254) NOT NULL,
        plan_name VARCHAR(40) NOT NULL,
        monthly_amount NUMERIC(10, 2) NOT NULL CHECK (monthly_amount > 0),
        installments_total INTEGER NOT NULL CHECK (installments_total BETWEEN 1 AND 120),
        installments_paid INTEGER NOT NULL DEFAULT 1 CHECK (installments_paid >= 1),
        enrollment_date DATE NOT NULL,
        last_payment_date DATE NOT NULL,
        next_due_date DATE NOT NULL,
        reminder_sent_for DATE,
        reminder_7_days_sent_for DATE,
        reminder_1_day_sent_for DATE,
        gym_access_restricted BOOLEAN NOT NULL DEFAULT FALSE,
        gym_access_restricted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).then(() => database.query(`
      ALTER TABLE gym_membership_tracking
      ADD COLUMN IF NOT EXISTS enrollment_date DATE,
      ADD COLUMN IF NOT EXISTS reminder_sent_for DATE,
      ADD COLUMN IF NOT EXISTS reminder_7_days_sent_for DATE,
      ADD COLUMN IF NOT EXISTS reminder_1_day_sent_for DATE,
      ADD COLUMN IF NOT EXISTS gym_access_restricted BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS gym_access_restricted_at TIMESTAMPTZ
    `)).then(() => database.query(`
      UPDATE gym_membership_tracking AS membership
      SET enrollment_date = COALESCE((
        SELECT customer.enrollment_date
        FROM gym_registered_customers AS customer
        WHERE LOWER(BTRIM(customer.customer_email)) = LOWER(BTRIM(membership.customer_email))
        LIMIT 1
      ), membership.last_payment_date)
      WHERE membership.enrollment_date IS NULL
    `)).then(() => database.query(`
      ALTER TABLE gym_membership_tracking
      ALTER COLUMN enrollment_date SET NOT NULL
    `)).then(() => database.query(`
      UPDATE gym_membership_tracking
      SET reminder_1_day_sent_for = reminder_sent_for
      WHERE reminder_sent_for = next_due_date
        AND reminder_1_day_sent_for IS NULL
    `)).then(() => database.query(`
      CREATE INDEX IF NOT EXISTS gym_membership_tracking_due_idx
      ON gym_membership_tracking (next_due_date)
    `)).catch((error) => {
      membershipTrackingTableReady = undefined;
      throw error;
    });
  }

  await membershipTrackingTableReady;
}

async function getMembershipAccessStatus(customerEmail, planName) {
  await ensureMembershipTrackingTable();
  const result = await database.query(`
    SELECT next_due_date, gym_access_restricted,
      GREATEST(
        (CURRENT_TIMESTAMP AT TIME ZONE 'America/Caracas')::date - next_due_date,
        0
      ) AS days_overdue
    FROM gym_membership_tracking
    WHERE LOWER(BTRIM(customer_email)) = LOWER(BTRIM($1))
      AND LOWER(BTRIM(plan_name)) = LOWER(BTRIM($2))
    ORDER BY id
    LIMIT 1
  `, [customerEmail, planName]);
  const membership = result.rows[0];
  return {
    nextDueDate: membership ? String(membership.next_due_date).slice(0, 10) : null,
    daysOverdue: Number(membership?.days_overdue || 0),
    accessRestricted: Boolean(membership?.gym_access_restricted),
  };
}

function isValidPaymentDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf())
    && date.toISOString().slice(0, 10) === value
    && date <= new Date();
}

function getMonthlyDate(value, enrollmentDate = value) {
  const [year, month] = value.split("-").map(Number);
  const day = Number(enrollmentDate.split("-")[2]);
  const targetMonth = new Date(Date.UTC(year, month - 1, 1));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  targetMonth.setUTCDate(Math.min(day, lastDay));
  return targetMonth.toISOString().slice(0, 10);
}

function getNextMonthlyDate(value, enrollmentDate = value) {
  const [year, month] = value.split("-").map(Number);
  const nextMonth = new Date(Date.UTC(year, month, 1));
  return getMonthlyDate(nextMonth.toISOString().slice(0, 10), enrollmentDate);
}

async function sendDueMembershipReminders() {
  if (membershipReminderCheckRunning) return;
  membershipReminderCheckRunning = true;
  try {
    await ensureMembershipTrackingTable();
    while (true) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(`
          SELECT id, customer_name, customer_email, plan_name, monthly_amount, next_due_date,
            CASE
              WHEN next_due_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Caracas')::date + 7 THEN 7
              ELSE 1
            END AS days_before_due
          FROM gym_membership_tracking
          WHERE (
              next_due_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Caracas')::date + 7
              AND reminder_7_days_sent_for IS DISTINCT FROM next_due_date
            ) OR (
              next_due_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Caracas')::date + 1
              AND reminder_1_day_sent_for IS DISTINCT FROM next_due_date
            )
          ORDER BY next_due_date, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `);
        const membership = result.rows[0];
        if (!membership) {
          await client.query("COMMIT");
          break;
        }

        await sendMembershipReminder(membership, Number(membership.days_before_due));
        const reminderColumn = Number(membership.days_before_due) === 7
          ? "reminder_7_days_sent_for"
          : "reminder_1_day_sent_for";
        await client.query(
          `UPDATE gym_membership_tracking SET ${reminderColumn} = next_due_date WHERE id = $1`,
          [membership.id],
        );
        await client.query("COMMIT");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error("No se pudo revertir el envío del recordatorio de mensualidad:", rollbackError);
        }
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    membershipReminderCheckRunning = false;
  }
}

async function sendMembershipReminder(membership, daysBeforeDue = null) {
  const dueDate = new Date(`${String(membership.next_due_date).slice(0, 10)}T00:00:00.000Z`)
    .toLocaleDateString("es-VE", { timeZone: "UTC" });
  const monthlyAmount = Number(membership.monthly_amount).toFixed(2);
  const reminderTiming = daysBeforeDue === 7
    ? "Faltan 7 días para el vencimiento de tu mensualidad."
    : daysBeforeDue === 1
      ? "Tu mensualidad vence mañana."
      : `te recordamos que el ${dueDate} vence la mensualidad`;
  const subject = daysBeforeDue
    ? `Recordatorio: tu mensualidad vence en ${daysBeforeDue} día${daysBeforeDue === 1 ? "" : "s"} - Esmeralda Gym`
    : `Recordatorio: tu mensualidad vence el ${dueDate} - Esmeralda Gym`;
  await createMailer().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: membership.customer_email,
    subject,
    text: `Hola ${membership.customer_name}, ${reminderTiming} El pago de tu plan ${membership.plan_name} es de $${monthlyAmount} USD y vence el ${dueDate}. Para mantener tu membresía al día, comunícate con Esmeralda Gym una vez realizado el pago.`,
    html: `<!doctype html><html lang="es"><body style="margin:0;padding:24px;background:#f3f6f3;font-family:Arial,sans-serif;color:#17231c">
      <main style="max-width:620px;margin:auto;padding:28px;background:#fff;border-top:5px solid #b4d83e">
        <p style="margin:0;color:#167446;font-weight:bold;letter-spacing:2px">ESMERALDA GYM</p>
        <h1 style="color:#10251b">Recordatorio de mensualidad</h1>
        <p>Hola ${escapeHtml(membership.customer_name)}, ${escapeHtml(reminderTiming)} El pago de tu plan <strong>${escapeHtml(membership.plan_name)}</strong> vence el <strong>${dueDate}</strong>.</p>
        <p>Monto: <strong>$${monthlyAmount} USD</strong></p>
        <p>Una vez realizado el pago, comunícate con Esmeralda Gym para mantener tu membresía al día.</p>
      </main>
    </body></html>`,
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);
}

async function getPaymentPlanForSubmission(payment) {
  const currentPlan = await getPaymentPlanByName(payment.plan_name);
  const fallbackPlan = currentPlan || defaultPaymentPlans[payment.plan_name] || {};
  if (!fallbackPlan.image && !payment.plan_image_name) return null;
  if (payment.enrollment_fee == null && fallbackPlan.enrollmentFee == null) return null;
  if (payment.membership_fee == null && fallbackPlan.membershipFee == null) return null;
  if (!payment.plan_period && !fallbackPlan.period) return null;

  return {
    ...fallbackPlan,
    enrollmentFee: payment.enrollment_fee == null ? fallbackPlan.enrollmentFee : Number(payment.enrollment_fee),
    membershipFee: payment.membership_fee == null ? fallbackPlan.membershipFee : Number(payment.membership_fee),
    period: payment.plan_period || fallbackPlan.period,
    image: payment.plan_image_name || fallbackPlan.image,
    imageMimeType: payment.plan_image_mime_type || fallbackPlan.imageMimeType,
    imageData: payment.plan_image_data || fallbackPlan.imageData,
  };
}

async function getPlansForSubmission(payment) {
  if (Array.isArray(payment.plan_details) && payment.plan_details.length) {
    const firstPlanImage = payment.plan_image_data
      ? {
        image: payment.plan_image_name,
        imageMimeType: payment.plan_image_mime_type,
        imageData: payment.plan_image_data,
      }
      : null;
    return payment.plan_details.map((plan, index) => ({
      ...plan,
      ...(index === 0 && firstPlanImage ? firstPlanImage : {}),
    }));
  }
  const plan = await getPaymentPlanForSubmission(payment);
  return plan ? [plan] : [];
}

function getPaymentFeeRows(payment, plans) {
  if (payment.payment_type === "membership") {
    return plans.map((plan) => ({
      label: `${plan.period} - ${plan.name}`,
      amount: Number(plan.membershipFee),
    }));
  }
  return plans.flatMap((plan) => [
    { label: `Inscripción - ${plan.name}`, amount: Number(plan.enrollmentFee) },
    { label: `${plan.period} - ${plan.name}`, amount: Number(plan.membershipFee) },
  ]);
}

function buildInvoicePdf(payment, plans, invoiceDate) {
  const firstPlan = plans[0];
  const imageSource = firstPlan.imageData || path.join(__dirname, "images_planes", firstPlan.image);
  const feeRows = getPaymentFeeRows(payment, plans);
  const total = feeRows.reduce((sum, row) => sum + row.amount, 0);
  const chunks = [];
  const document = new PDFDocument({ size: "A4", margin: 48 });
  const result = new Promise((resolve, reject) => {
    document.on("data", (chunk) => chunks.push(chunk));
    document.once("end", () => resolve(Buffer.concat(chunks)));
    document.once("error", reject);
  });

  document.rect(0, 0, 595, 128).fill("#10251b");
  document.fillColor("#b4d83e").fontSize(11).text("ESMERALDA GYM", 48, 34);
  document.fillColor("#ffffff").fontSize(25).text("Factura de pago aprobado", 48, 55);
  document.fillColor("#dce3de").fontSize(10)
    .text(`Factura EG-${String(payment.id).padStart(6, "0")}  |  ${invoiceDate}`, 48, 94);
  document.fillColor("#17231c").fontSize(12).text(`Cliente: ${payment.customer_name}`, 48, 154);
  document.text(`Correo: ${payment.customer_email}`, 48, 175);
  document.text(`Teléfono: ${payment.customer_phone}`, 48, 196);
  document.text(`Fecha del pago: ${new Date(payment.payment_date).toLocaleDateString("es-VE", { timeZone: "UTC" })}`, 48, 217);
  document.text(`Método de pago: ${payment.payment_method}`, 48, 238);
  document.fontSize(16).fillColor("#167446").text(plans.map((plan) => plan.name).join(", "), 48, 260, { width: 280 });
  document.image(imageSource, 342, 254, { fit: [205, 260], align: "right", valign: "center" });

  const tableTop = 305;
  const tableRight = 320;
  document.fillColor("#10251b").fontSize(10).text("Concepto", 48, tableTop);
  document.text("Importe", 238, tableTop, { width: 82, align: "right" });
  document.moveTo(48, tableTop + 20).lineTo(tableRight, tableTop + 20).stroke("#cbd6ce");
  feeRows.forEach((row, index) => {
    const rowTop = tableTop + 34 + index * 23;
    document.fillColor("#17231c").fontSize(11)
      .text(row.label, 48, rowTop, { width: 168 })
      .text(`$${row.amount.toFixed(2)} USD`, 220, rowTop, { width: 100, align: "right" });
  });
  const totalSeparatorTop = tableTop + 34 + feeRows.length * 23;
  document.moveTo(48, totalSeparatorTop).lineTo(tableRight, totalSeparatorTop).stroke("#cbd6ce");
  document.font("Helvetica-Bold").fontSize(13).fillColor("#10251b")
    .text("Total pagado", 48, totalSeparatorTop + 14)
    .text(`$${total.toFixed(2)} USD`, 210, totalSeparatorTop + 14, { width: 110, align: "right" });
  document.font("Helvetica").fontSize(9).fillColor("#68736c")
    .text("Gracias por elegir Esmeralda Gym. Conserva esta factura como comprobante de tu pago.", 48, 760, { width: 495 });
  document.end();
  return result;
}

function requireAdmin(request, response, next) {
  response.set("Cache-Control", "no-store");
  const authorization = request.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match || !process.env.ADMIN_JWT_SECRET || process.env.ADMIN_JWT_SECRET.length < 32) {
    return response.status(401).json({ error: "Inicia sesión como administrador para continuar." });
  }

  try {
    const payload = jwt.verify(match[1], process.env.ADMIN_JWT_SECRET);
    if (typeof payload !== "object" || payload.role !== "admin") {
      return response.status(403).json({ error: "No tienes permisos de administrador." });
    }
  } catch {
    return response.status(401).json({ error: "La sesión administrativa venció. Inicia sesión de nuevo." });
  }

  return next();
}

function getCustomerJwtSecret() {
  return process.env.CUSTOMER_JWT_SECRET || process.env.ADMIN_JWT_SECRET || "";
}

function requireCustomer(request, response, next) {
  response.set("Cache-Control", "no-store");
  const authorization = request.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const secret = getCustomerJwtSecret();
  if (!match || secret.length < 32) {
    return response.status(401).json({ error: "Inicia sesión como cliente para continuar." });
  }

  try {
    const payload = jwt.verify(match[1], secret);
    if (typeof payload !== "object" || payload.role !== "customer" || !/^\d+$/.test(String(payload.customerId || ""))) {
      return response.status(403).json({ error: "No tienes permisos para consultar esta cuenta." });
    }
    request.customerId = payload.customerId;
  } catch {
    return response.status(401).json({ error: "La sesión venció. Inicia sesión de nuevo." });
  }

  return next();
}

function requireCustomerForMembershipPayment(request, response, next) {
  if (request.body?.paymentType !== "membership") return next();
  return requireCustomer(request, response, next);
}

async function ensureUsersTable() {
  if (!usersTableReady) {
    usersTableReady = database.query(`
      CREATE TABLE IF NOT EXISTS gym_users (
        id BIGSERIAL PRIMARY KEY,
        username VARCHAR(40) NOT NULL UNIQUE,
        email VARCHAR(254) UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).then(() => database.query(`
      ALTER TABLE gym_users ADD COLUMN IF NOT EXISTS email VARCHAR(254) UNIQUE
    `)).then(() => database.query(`
      CREATE TABLE IF NOT EXISTS gym_password_resets (
        user_id BIGINT PRIMARY KEY REFERENCES gym_users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)).then(() => database.query(`
      CREATE TABLE IF NOT EXISTS gym_registration_verifications (
        email VARCHAR(254) PRIMARY KEY,
        username VARCHAR(40) NOT NULL,
        password_hash TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)).catch((error) => {
      usersTableReady = undefined;
      throw error;
    });
  }

  await usersTableReady;
}

function readCredentials(request) {
  const username = typeof request.body?.username === "string"
    ? request.body.username.trim()
    : "";
  const password = typeof request.body?.password === "string"
    ? request.body.password
    : "";

  return { username, password };
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isValidEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function createMailer() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD?.replace(/\s/g, "");
  const from = process.env.SMTP_FROM || user;

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !user || !password || !from) {
    throw new Error("Falta SMTP_PASSWORD: configura una contraseña de aplicación de Gmail en el entorno del backend. SMTP_HOST, SMTP_USER, SMTP_PORT y SMTP_FROM ya tienen valores predeterminados/configurados para Esmeralda Gym.");
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === "true",
    auth: { user, pass: password },
  });
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use("/images", express.static(path.join(__dirname, "images")));
app.use("/images_collage", express.static(path.join(__dirname, "images_collage")));
app.use("/images.coachs", express.static(path.join(__dirname, "images.coachs")));
app.use("/images_planes", express.static(path.join(__dirname, "images_planes")));

app.use("/api/auth", express.json());
app.post("/api/auth/register/send-code", async (request, response) => {
  const { username, password } = readCredentials(request);
  const email = normalizeEmail(request.body?.email);

  if (username.length < 3 || username.length > 40 || !isValidEmail(email) || Buffer.byteLength(password, "utf8") < 8 || Buffer.byteLength(password, "utf8") > 72) {
    return response.status(400).json({ error: "Ingresa un usuario de 3 a 40 caracteres, un correo válido y una contraseña de 8 a 72 bytes." });
  }

  let mailer;
  try {
    mailer = createMailer();
  } catch (error) {
    console.error("El correo de registro no está configurado:", error);
    return response.status(503).json({ error: error.message });
  }

  try {
    await ensureUsersTable();
    const existingAccount = await database.query(
      "SELECT username, email FROM gym_users WHERE username = $1 OR email = $2",
      [username, email],
    );
    if (existingAccount.rows.length) {
      const account = existingAccount.rows[0];
      return response.status(409).json({
        error: account.email === email
          ? "Ese correo electrónico ya está registrado."
          : "Ese nombre de usuario ya está registrado.",
      });
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const [passwordHash, codeHash] = await Promise.all([
      bcrypt.hash(password, 12),
      bcrypt.hash(code, 12),
    ]);
    const verification = await database.query(
      `INSERT INTO gym_registration_verifications
         (email, username, password_hash, code_hash, expires_at, attempts, created_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '15 minutes', 0, NOW())
       ON CONFLICT (email) DO UPDATE
       SET username = EXCLUDED.username,
           password_hash = EXCLUDED.password_hash,
           code_hash = EXCLUDED.code_hash,
           expires_at = EXCLUDED.expires_at,
           attempts = 0,
           created_at = NOW()
       WHERE gym_registration_verifications.created_at < NOW() - INTERVAL '60 seconds'
       RETURNING email`,
      [email, username, passwordHash, codeHash],
    );

    if (!verification.rowCount) {
      return response.status(429).json({ error: "Espera 60 segundos antes de solicitar otro código." });
    }

    try {
      await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: email,
        subject: "Esmeralda Gym | Verifica tu correo",
        text: `Hola,\n\nTu código para crear una cuenta en Esmeralda Gym es: ${code}\n\nEl código vence en 15 minutos. Si no solicitaste esta cuenta, puedes ignorar este mensaje.\n\nEsmeralda Gym`,
      });
    } catch (error) {
      console.error("No se pudo enviar el código de registro:", {
        code: error.code,
        responseCode: error.responseCode,
        command: error.command,
        message: error.message,
      });
      try {
        await database.query(
          "DELETE FROM gym_registration_verifications WHERE email = $1 AND code_hash = $2",
          [email, codeHash],
        );
      } catch (cleanupError) {
        console.error("No se pudo limpiar el código de registro cuyo correo falló:", cleanupError);
      }

      const authenticationRejected = error.code === "EAUTH" || error.responseCode === 535;
      return response.status(503).json({
        error: authenticationRejected
          ? "Gmail rechazó la autenticación SMTP. Verifica SMTP_USER y que SMTP_PASSWORD sea una contraseña de aplicación de Google válida."
          : "No se pudo conectar o enviar el correo por SMTP. Revisa la configuración y los registros del backend.",
      });
    }

    return response.json({ message: "Enviamos un código de verificación a tu correo. Vence en 15 minutos." });
  } catch (error) {
    console.error("No se pudo iniciar el registro:", error);
    return response.status(503).json({ error: "No se pudo iniciar el registro." });
  }
});

app.post("/api/auth/register/verify-code", async (request, response) => {
  const email = normalizeEmail(request.body?.email);
  const code = typeof request.body?.code === "string" ? request.body.code.trim() : "";

  if (!isValidEmail(email) || !/^\d{6}$/.test(code)) {
    return response.status(400).json({ error: "Escribe un correo válido y el código de 6 dígitos." });
  }

  let client;
  try {
    await ensureUsersTable();
    client = await database.connect();
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT email, username, password_hash, code_hash, expires_at, attempts
       FROM gym_registration_verifications
       WHERE email = $1
       FOR UPDATE`,
      [email],
    );
    const verification = result.rows[0];

    if (!verification) {
      await client.query("ROLLBACK");
      return response.status(400).json({ error: "El código no es válido o ya venció. Solicita uno nuevo." });
    }

    if (new Date(verification.expires_at) <= new Date() || verification.attempts >= 5) {
      await client.query("DELETE FROM gym_registration_verifications WHERE email = $1", [email]);
      await client.query("COMMIT");
      return response.status(400).json({ error: "El código no es válido o ya venció. Solicita uno nuevo." });
    }

    if (!(await bcrypt.compare(code, verification.code_hash))) {
      if (verification.attempts + 1 >= 5) {
        await client.query("DELETE FROM gym_registration_verifications WHERE email = $1", [email]);
      } else {
        await client.query(
          "UPDATE gym_registration_verifications SET attempts = attempts + 1 WHERE email = $1",
          [email],
        );
      }
      await client.query("COMMIT");
      return response.status(400).json({ error: "El código no es válido o ya venció. Solicita uno nuevo." });
    }

    await client.query(
      "INSERT INTO gym_users (username, email, password_hash) VALUES ($1, $2, $3)",
      [verification.username, email, verification.password_hash],
    );
    await client.query("DELETE FROM gym_registration_verifications WHERE email = $1", [email]);
    await client.query("COMMIT");
    return response.status(201).json({ message: "Cuenta creada" });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("No se pudo revertir la transacción de registro:", rollbackError);
      }
    }
    if (error.code === "23505") {
      const message = error.constraint === "gym_users_email_key"
        ? "Ese correo electrónico ya está registrado."
        : "Ese nombre de usuario ya está registrado.";
      return response.status(409).json({ error: message });
    }
    console.error("No se pudo verificar el correo de registro:", error);
    return response.status(503).json({ error: "No se pudo verificar el correo ni crear la cuenta." });
  } finally {
    if (client) client.release();
  }
});

app.post("/api/auth/register", async (request, response) => {
  return response.status(410).json({ error: "El registro requiere verificar el correo. Solicita un código para continuar." });
});

app.post("/api/auth/forgot-password", async (request, response) => {
  const email = normalizeEmail(request.body?.email);
  if (!isValidEmail(email)) {
    return response.status(400).json({ error: "Escribe un correo electrónico válido." });
  }

  let mailer;
  try {
    mailer = createMailer();
  } catch (error) {
    console.error("El correo de recuperación no está configurado:", error);
    return response.status(503).json({ error: error.message });
  }

  try {
    await ensureUsersTable();
    const result = await database.query(
      "SELECT id FROM gym_users WHERE email = $1",
      [email],
    );
    const account = result.rows[0];

    if (account) {
      const code = String(crypto.randomInt(100000, 1000000));
      const codeHash = await bcrypt.hash(code, 12);
      const reset = await database.query(
        `INSERT INTO gym_password_resets (user_id, code_hash, expires_at, attempts, created_at)
         VALUES ($1, $2, NOW() + INTERVAL '15 minutes', 0, NOW())
         ON CONFLICT (user_id) DO UPDATE
         SET code_hash = EXCLUDED.code_hash,
             expires_at = EXCLUDED.expires_at,
             attempts = 0,
             created_at = NOW()
         WHERE gym_password_resets.created_at < NOW() - INTERVAL '60 seconds'
         RETURNING user_id`,
        [account.id, codeHash],
      );

      if (reset.rowCount) {
        try {
          await mailer.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: email,
            subject: "Esmeralda Gym | Código para restablecer tu contraseña",
            text: `Hola,\n\nTu código de verificación para restablecer la contraseña de Esmeralda Gym es: ${code}\n\nEl código vence en 15 minutos. Si no solicitaste este cambio, puedes ignorar este mensaje.\n\nEsmeralda Gym`,
          });
        } catch (error) {
          console.error("No se pudo enviar el código de recuperación:", {
            code: error.code,
            responseCode: error.responseCode,
            command: error.command,
            message: error.message,
          });
          try {
            await database.query(
              "DELETE FROM gym_password_resets WHERE user_id = $1 AND code_hash = $2",
              [account.id, codeHash],
            );
          } catch (cleanupError) {
            console.error("No se pudo limpiar el código de recuperación cuyo correo falló:", cleanupError);
          }

          const authenticationRejected = error.code === "EAUTH" || error.responseCode === 535;
          return response.status(503).json({
            error: authenticationRejected
              ? "Gmail rechazó la autenticación SMTP. Verifica SMTP_USER y que SMTP_PASSWORD sea una contraseña de aplicación de Google válida."
              : "No se pudo conectar o enviar el correo por SMTP. Revisa la configuración y los registros del backend.",
          });
        }
      }
    }

    return response.json({
      message: "Si el correo corresponde a una cuenta, recibirás un código de verificación.",
    });
  } catch (error) {
    console.error("No se pudo iniciar la recuperación de contraseña:", error);
    return response.status(503).json({ error: "No se pudo iniciar la recuperación de contraseña." });
  }
});

app.post("/api/auth/reset-password", async (request, response) => {
  const email = normalizeEmail(request.body?.email);
  const code = typeof request.body?.code === "string" ? request.body.code.trim() : "";
  const password = typeof request.body?.password === "string" ? request.body.password : "";

  if (!isValidEmail(email) || !/^\d{6}$/.test(code) || Buffer.byteLength(password, "utf8") < 8 || Buffer.byteLength(password, "utf8") > 72) {
    return response.status(400).json({ error: "Verifica el correo y el código, y usa una contraseña de 8 a 72 bytes." });
  }

  let client;
  try {
    await ensureUsersTable();
    client = await database.connect();
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT u.id, r.code_hash, r.expires_at, r.attempts
       FROM gym_users u
       JOIN gym_password_resets r ON r.user_id = u.id
       WHERE u.email = $1
       FOR UPDATE OF r`,
      [email],
    );
    const reset = result.rows[0];

    if (!reset) {
      await client.query("ROLLBACK");
      return response.status(400).json({ error: "El código no es válido o ya venció. Solicita uno nuevo." });
    }

    if (new Date(reset.expires_at) <= new Date() || reset.attempts >= 5) {
      await client.query("DELETE FROM gym_password_resets WHERE user_id = $1", [reset.id]);
      await client.query("COMMIT");
      return response.status(400).json({ error: "El código no es válido o ya venció. Solicita uno nuevo." });
    }

    if (!(await bcrypt.compare(code, reset.code_hash))) {
      if (reset.attempts + 1 >= 5) {
        await client.query("DELETE FROM gym_password_resets WHERE user_id = $1", [reset.id]);
      } else {
        await client.query(
          "UPDATE gym_password_resets SET attempts = attempts + 1 WHERE user_id = $1",
          [reset.id],
        );
      }
      await client.query("COMMIT");
      return response.status(400).json({ error: "El código no es válido o ya venció. Solicita uno nuevo." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await client.query("UPDATE gym_users SET password_hash = $1 WHERE id = $2", [passwordHash, reset.id]);
    await client.query("DELETE FROM gym_password_resets WHERE user_id = $1", [reset.id]);
    await client.query("COMMIT");
    return response.json({ message: "Contraseña actualizada. Ya puedes iniciar sesión." });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("No se pudo revertir la transacción de restablecimiento:", rollbackError);
      }
    }
    console.error("No se pudo restablecer la contraseña:", error);
    return response.status(503).json({ error: "No se pudo restablecer la contraseña." });
  } finally {
    if (client) client.release();
  }
});

app.get("/api/payment-settings", async (request, response) => {
  try {
    response.set("Cache-Control", "no-store");
    return response.json({ settings: await getPaymentSettings() });
  } catch (error) {
    console.error("No se pudieron cargar los datos públicos de Pago Móvil:", error);
    return response.status(503).json({ error: "No se pudieron cargar los datos de pago." });
  }
});

function parseBcvNumber(value) {
  const normalized = value.replace(/\./g, "").replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function refreshBcvRate() {
  if (bcvRateRefreshPromise) return bcvRateRefreshPromise;
  bcvRateRefreshPromise = (async () => {
    const upstream = await fetch("https://www.bcv.org.ve/", {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(10000),
    });
    if (!upstream.ok) throw new Error(`El BCV respondió con HTTP ${upstream.status}.`);
    const html = await upstream.text();
    const dollarStart = html.search(/id=["']dolar["']/i);
    if (dollarStart < 0) throw new Error("No se encontró la tasa USD en la página del BCV.");

    const dollarSection = html.slice(dollarStart, dollarStart + 5000);
    const rawRate = dollarSection.match(/<strong\b[^>]*>\s*([\d.,]+)\s*<\/strong>/i)?.[1];
    const rate = rawRate ? parseBcvNumber(rawRate) : null;
    if (!rate) throw new Error("El BCV no publicó una tasa USD válida.");

    const pageText = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&aacute;/gi, "á")
      .replace(/&eacute;/gi, "é")
      .replace(/&iacute;/gi, "í")
      .replace(/&oacute;/gi, "ó")
      .replace(/&uacute;/gi, "ú")
      .replace(/&ntilde;/gi, "ñ")
      .replace(/\s+/g, " ");
    const valueDate = pageText.match(/Fecha\s*Valor\s*:\s*((?:[A-Za-zÁÉÍÓÚáéíóúÑñ]+,?\s*)+\d{1,2}\s+[A-Za-zÁÉÍÓÚáéíóúÑñ]+\s+\d{4})/i)?.[1]?.trim();
    if (!valueDate) throw new Error("No se encontró la fecha valor de la tasa publicada por el BCV.");

    bcvRateCache = {
      rate,
      valueDate,
      fetchedAt: new Date().toISOString(),
    };
    return bcvRateCache;
  })().finally(() => {
    bcvRateRefreshPromise = null;
  });
  return bcvRateRefreshPromise;
}

app.get("/api/bcv-rate", async (request, response) => {
  response.set("Cache-Control", "no-store");
  const cacheIsFresh = bcvRateCache
    && Date.now() - Date.parse(bcvRateCache.fetchedAt) < bcvRateCacheTtlMs;
  if (cacheIsFresh) return response.json({ ...bcvRateCache, stale: false });

  try {
    const rate = await refreshBcvRate();
    return response.json({ ...rate, stale: false });
  } catch (error) {
    console.error("No se pudo actualizar la tasa oficial del BCV:", error);
    if (bcvRateCache) return response.json({ ...bcvRateCache, stale: true });
    return response.status(503).json({ error: "No se pudo consultar la tasa oficial del BCV. Inténtalo de nuevo más tarde." });
  }
});

app.post("/api/customer/login", express.json({ limit: "4kb" }), async (request, response) => {
  response.set("Cache-Control", "no-store");
  const email = normalizeEmail(request.body?.email);
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  const secret = getCustomerJwtSecret();
  if (!isValidEmail(email) || Buffer.byteLength(password, "utf8") < 8 || Buffer.byteLength(password, "utf8") > 72) {
    return response.status(400).json({ error: "Ingresa un correo y una contraseña válidos." });
  }
  if (secret.length < 32) {
    return response.status(503).json({ error: "El acceso de clientes no está configurado en el servidor." });
  }

  const clientAddress = request.ip;
  const now = Date.now();
  let attempts = customerLoginAttempts.get(clientAddress);
  if (!attempts || now - attempts.startedAt >= 15 * 60 * 1000) {
    attempts = { startedAt: now, count: 0 };
    customerLoginAttempts.set(clientAddress, attempts);
  }
  if (attempts.count >= 5) {
    return response.status(429).json({ error: "Demasiados intentos. Espera 15 minutos antes de volver a intentarlo." });
  }

  try {
    await ensureRegisteredCustomersTable();
    await ensurePlansTable();
    const result = await database.query(`
      SELECT customer.id, customer.customer_name, customer.customer_email, customer.customer_phone,
        customer.plan_name, customer.customer_password_hash, plan.period AS plan_period
      FROM gym_registered_customers AS customer
      LEFT JOIN gym_payment_plans AS plan ON plan.name = customer.plan_name
      WHERE customer.customer_email = $1
      LIMIT 1
    `, [email]);
    const customer = result.rows[0];
    if (!customer?.customer_password_hash || !(await bcrypt.compare(password, customer.customer_password_hash))) {
      attempts.count += 1;
      return response.status(401).json({ error: "Correo o contraseña incorrectos." });
    }

    const membershipStatus = await getMembershipAccessStatus(customer.customer_email, customer.plan_name);
    customerLoginAttempts.delete(clientAddress);
    const token = jwt.sign({
      role: "customer",
      customerId: String(customer.id),
    }, secret, { expiresIn: "8h" });
    return response.json({
      token,
      customer: {
        name: customer.customer_name,
        email: customer.customer_email,
        phone: customer.customer_phone,
        planName: customer.plan_name,
        planPeriod: customer.plan_period,
        ...membershipStatus,
      },
    });
  } catch (error) {
    console.error("No se pudo iniciar sesión como cliente:", error);
    return response.status(503).json({ error: "No se pudo iniciar sesión. Inténtalo de nuevo más tarde." });
  }
});

app.get("/api/customer-membership-plan", requireCustomer, async (request, response) => {
  try {
    await ensureRegisteredCustomersTable();
    await ensurePlansTable();
    const result = await database.query(`
      SELECT customer.customer_name, customer.customer_email, customer.customer_phone,
        customer.plan_name, plan.period AS plan_period
      FROM gym_registered_customers AS customer
      LEFT JOIN gym_payment_plans AS plan ON plan.name = customer.plan_name
      WHERE customer.id = $1
      LIMIT 1
    `, [request.customerId]);
    if (!result.rowCount) return response.status(404).json({ error: "No se encontró la cuenta del cliente." });
    const customer = result.rows[0];
    const membershipStatus = await getMembershipAccessStatus(customer.customer_email, customer.plan_name);
    return response.json({
      customer: {
        name: customer.customer_name,
        email: customer.customer_email,
        phone: customer.customer_phone,
        planName: customer.plan_name,
        planPeriod: customer.plan_period,
        ...membershipStatus,
      },
    });
  } catch (error) {
    console.error("No se pudo consultar el plan del cliente autenticado:", error);
    return response.status(503).json({ error: "No se pudo consultar el plan registrado." });
  }
});

app.use("/api/admin", express.json({ limit: "12kb" }));

app.get("/api/admin/payment-settings", requireAdmin, async (request, response) => {
  try {
    return response.json({ settings: await getPaymentSettings() });
  } catch (error) {
    console.error("No se pudieron cargar los datos de Pago Móvil:", error);
    return response.status(503).json({ error: "No se pudieron cargar los datos de Pago Móvil." });
  }
});

app.put("/api/admin/payment-settings", requireAdmin, async (request, response) => {
  const bankName = typeof request.body?.bankName === "string" ? request.body.bankName.trim() : "";
  const bankCode = typeof request.body?.bankCode === "string" ? request.body.bankCode.trim() : "";
  const documentId = typeof request.body?.documentId === "string" ? request.body.documentId.trim() : "";
  const phone = typeof request.body?.phone === "string" ? request.body.phone.trim() : "";

  if (!bankName || bankName.length > 80 || !/^\d{4}$/.test(bankCode)
    || !/^[A-Za-z0-9.-]{5,20}$/.test(documentId) || !/^[\d+(). -]{7,20}$/.test(phone)) {
    return response.status(400).json({
      error: "Ingresa un banco, código bancario de 4 dígitos, documento y teléfono válidos.",
    });
  }

  try {
    await ensurePaymentSettingsTable();
    await database.query(`
      UPDATE gym_payment_settings
      SET bank_name = $1, bank_code = $2, document_id = $3, phone = $4, updated_at = NOW()
      WHERE id = 1
    `, [bankName, bankCode, documentId, phone]);
    return response.json({ message: "Los datos de Pago Móvil se actualizaron correctamente." });
  } catch (error) {
    console.error("No se pudieron actualizar los datos de Pago Móvil:", error);
    return response.status(503).json({ error: "No se pudieron actualizar los datos de Pago Móvil." });
  }
});

app.get("/api/admin/plans", requireAdmin, async (request, response) => {
  try {
    const plans = await getPaymentPlans();
    return response.json({
      plans: plans.map(({ id, name, enrollmentFee, membershipFee, period, description, benefits, imageMimeType }) => ({
        id,
        name,
        enrollmentFee,
        membershipFee,
        period,
        description,
        benefits,
        imageUrl: `/plan-images/${id}`,
        imageMimeType,
      })),
    });
  } catch (error) {
    console.error("No se pudieron cargar los planes para administración:", error);
    return response.status(503).json({ error: "No se pudieron cargar los planes." });
  }
});

app.post("/api/admin/plans", requireAdmin, (request, response, next) => {
  planImageUpload.single("image")(request, response, (error) => {
    if (error) {
      const tooLarge = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
      return response.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? "La imagen del plan excede el límite de 5 MB." : "Adjunta una imagen JPG o PNG válida.",
      });
    }
    return next();
  });
}, async (request, response) => {
  const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
  const description = typeof request.body?.description === "string" ? request.body.description.trim() : "";
  const benefitsInput = typeof request.body?.benefits === "string" ? request.body.benefits : "";
  const benefits = benefitsInput.split(/\r?\n/).map((benefit) => benefit.trim()).filter(Boolean);
  const benefitsText = benefits.join("\n");
  const enrollmentFeeInput = typeof request.body?.enrollmentFee === "string" ? request.body.enrollmentFee : "";
  const membershipFeeInput = typeof request.body?.membershipFee === "string" ? request.body.membershipFee : "";
  const period = typeof request.body?.period === "string" ? request.body.period : "";
  const enrollmentFee = Number(enrollmentFeeInput);
  const membershipFee = Number(membershipFeeInput);
  const image = request.file;

  if (!name || name.length > 40 || !description || description.length > 500
    || !benefits.length || benefitsText.length > 2000
    || !/^\d{1,8}(?:\.\d{1,2})?$/.test(enrollmentFeeInput)
    || !/^\d{1,8}(?:\.\d{1,2})?$/.test(membershipFeeInput)
    || !Number.isFinite(enrollmentFee) || enrollmentFee < 0
    || !Number.isFinite(membershipFee) || membershipFee <= 0
    || !["Mensualidad", "Semana"].includes(period)
    || !image || !getImageSignature(image.mimetype, image.buffer)) {
    return response.status(400).json({ error: "Completa un nombre, descripción, beneficios (uno por línea), precios y período válidos, y adjunta una imagen JPG o PNG válida." });
  }

  try {
    await ensurePlansTable();
    const result = await database.query(`
      INSERT INTO gym_payment_plans (
        name, enrollment_fee, membership_fee, period, description, benefits,
        image_name, image_mime_type, image_data
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [
      name,
      enrollmentFee,
      membershipFee,
      period,
      description,
      benefitsText,
      path.basename(image.originalname || "plan"),
      image.mimetype,
      image.buffer,
    ]);
    return response.status(201).json({ message: "Plan agregado correctamente.", planId: result.rows[0].id });
  } catch (error) {
    if (error.code === "23505") {
      return response.status(409).json({ error: "Ya existe un plan con ese nombre." });
    }
    console.error("No se pudo agregar el plan:", error);
    return response.status(503).json({ error: "No se pudo agregar el plan." });
  }
});

app.put("/api/admin/plans/:id", requireAdmin, (request, response, next) => {
  planImageUpload.single("image")(request, response, (error) => {
    if (error) {
      const tooLarge = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
      return response.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? "La imagen del plan excede el límite de 5 MB." : "Adjunta una imagen JPG o PNG válida.",
      });
    }
    return next();
  });
}, async (request, response) => {
  if (!/^\d+$/.test(request.params.id)) {
    return response.status(400).json({ error: "El identificador del plan no es válido." });
  }
  const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
  const description = typeof request.body?.description === "string" ? request.body.description.trim() : "";
  const benefitsInput = typeof request.body?.benefits === "string" ? request.body.benefits : "";
  const benefits = benefitsInput.split(/\r?\n/).map((benefit) => benefit.trim()).filter(Boolean);
  const benefitsText = benefits.join("\n");
  const enrollmentFeeInput = typeof request.body?.enrollmentFee === "string" ? request.body.enrollmentFee : "";
  const membershipFeeInput = typeof request.body?.membershipFee === "string" ? request.body.membershipFee : "";
  const period = typeof request.body?.period === "string" ? request.body.period : "";
  const enrollmentFee = Number(enrollmentFeeInput);
  const membershipFee = Number(membershipFeeInput);
  const image = request.file;

  if (!name || name.length > 40 || !description || description.length > 500
    || !benefits.length || benefitsText.length > 2000
    || !/^\d{1,8}(?:\.\d{1,2})?$/.test(enrollmentFeeInput)
    || !/^\d{1,8}(?:\.\d{1,2})?$/.test(membershipFeeInput)
    || !Number.isFinite(enrollmentFee) || enrollmentFee < 0
    || !Number.isFinite(membershipFee) || membershipFee <= 0
    || !["Mensualidad", "Semana"].includes(period)
    || (image && !getImageSignature(image.mimetype, image.buffer))) {
    return response.status(400).json({ error: "Completa un nombre, descripción, beneficios (uno por línea), precios y período válidos, y adjunta una imagen JPG o PNG válida." });
  }

  try {
    await ensurePlansTable();
    const result = await database.query(`
      UPDATE gym_payment_plans
      SET name = $1, enrollment_fee = $2, membership_fee = $3, period = $4, description = $5,
        benefits = $6,
        image_name = CASE WHEN $7::bytea IS NULL THEN image_name ELSE $8 END,
        image_mime_type = CASE WHEN $7::bytea IS NULL THEN image_mime_type ELSE $9 END,
        image_data = COALESCE($7::bytea, image_data),
        updated_at = NOW()
      WHERE id = $10
      RETURNING id
    `, [
      name,
      enrollmentFee,
      membershipFee,
      period,
      description,
      benefitsText,
      image?.buffer || null,
      image ? path.basename(image.originalname || "plan") : null,
      image?.mimetype || null,
      request.params.id,
    ]);
    if (!result.rowCount) return response.status(404).json({ error: "No se encontró el plan." });
    return response.json({ message: "Plan actualizado correctamente." });
  } catch (error) {
    if (error.code === "23505") {
      return response.status(409).json({ error: "Ya existe otro plan con ese nombre." });
    }
    console.error("No se pudo actualizar el plan:", error);
    return response.status(503).json({ error: "No se pudo actualizar el plan." });
  }
});

app.delete("/api/admin/plans/:id", requireAdmin, async (request, response) => {
  if (!/^\d+$/.test(request.params.id)) {
    return response.status(400).json({ error: "El identificador del plan no es válido." });
  }

  try {
    await ensurePlansTable();
    const result = await database.query(
      "DELETE FROM gym_payment_plans WHERE id = $1 RETURNING id",
      [request.params.id],
    );
    if (!result.rowCount) return response.status(404).json({ error: "No se encontró el plan." });
    return response.json({ message: "Plan eliminado correctamente." });
  } catch (error) {
    console.error("No se pudo eliminar el plan:", error);
    return response.status(503).json({ error: "No se pudo eliminar el plan." });
  }
});

app.get("/plan-images/:id", async (request, response) => {
  if (!/^\d+$/.test(request.params.id)) return response.sendStatus(404);
  try {
    await ensurePlansTable();
    const result = await database.query(
      "SELECT image_mime_type, image_data FROM gym_payment_plans WHERE id = $1",
      [request.params.id],
    );
    const plan = result.rows[0];
    if (!plan) return response.sendStatus(404);
    response.set("Cache-Control", "no-cache");
    response.type(plan.image_mime_type);
    return response.send(plan.image_data);
  } catch (error) {
    console.error("No se pudo cargar la imagen del plan:", error);
    return response.status(503).send("No se pudo cargar la imagen del plan.");
  }
});

app.post("/api/admin/login", async (request, response) => {
  response.set("Cache-Control", "no-store");
  const email = normalizeEmail(request.body?.email);
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  const configuredEmail = normalizeEmail(process.env.ADMIN_EMAIL);
  const configuredPassword = process.env.ADMIN_PASSWORD || "";

  if (!isValidEmail(configuredEmail) || Buffer.byteLength(configuredPassword, "utf8") < 16
    || !process.env.ADMIN_JWT_SECRET || process.env.ADMIN_JWT_SECRET.length < 32) {
    return response.status(503).json({ error: "Configura ADMIN_EMAIL, ADMIN_PASSWORD y ADMIN_JWT_SECRET en el entorno del servidor." });
  }

  const clientAddress = request.ip;
  const now = Date.now();
  let attempts = adminLoginAttempts.get(clientAddress);
  if (!attempts || now - attempts.startedAt >= 15 * 60 * 1000) {
    attempts = { startedAt: now, count: 0 };
    adminLoginAttempts.set(clientAddress, attempts);
  }
  if (attempts.count >= 5) {
    return response.status(429).json({ error: "Demasiados intentos. Espera 15 minutos antes de volver a intentarlo." });
  }

  const emailBuffer = Buffer.from(email);
  const configuredEmailBuffer = Buffer.from(configuredEmail);
  const passwordBuffer = Buffer.from(password);
  const configuredPasswordBuffer = Buffer.from(configuredPassword);
  const emailMatches = emailBuffer.length === configuredEmailBuffer.length
    && crypto.timingSafeEqual(emailBuffer, configuredEmailBuffer);
  const passwordMatches = passwordBuffer.length === configuredPasswordBuffer.length
    && crypto.timingSafeEqual(passwordBuffer, configuredPasswordBuffer);

  if (!emailMatches || !passwordMatches) {
    attempts.count += 1;
    return response.status(401).json({ error: "Correo administrativo o contraseña incorrectos." });
  }

  adminLoginAttempts.delete(clientAddress);
  const token = jwt.sign({ role: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "8h" });
  return response.json({ token });
});

app.post("/api/admin/customers", requireAdmin, (request, response, next) => {
  customerEnrollmentProofUpload.single("enrollmentProof")(request, response, (error) => {
    if (error) {
      const tooLarge = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
      return response.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? "El comprobante excede el límite de 8 MB." : "Adjunta un comprobante en formato JPG o PNG.",
      });
    }
    return next();
  });
}, async (request, response) => {
  const firstName = typeof request.body?.firstName === "string" ? request.body.firstName.trim() : "";
  const lastName = typeof request.body?.lastName === "string" ? request.body.lastName.trim() : "";
  const phone = typeof request.body?.phone === "string" ? request.body.phone.trim() : "";
  const customerEmail = normalizeEmail(request.body?.email);
  const planName = typeof request.body?.planName === "string" ? request.body.planName.trim() : "";
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  const registrationDate = typeof request.body?.registrationDate === "string" ? request.body.registrationDate : "";
  const enrollmentProof = request.file;
  const phoneDigits = phone.replace(/\D/g, "");

  if (!enrollmentProof) {
    return response.status(400).json({ error: "Adjunta el comprobante de inscripción. Es obligatorio para registrar al cliente." });
  }
  if (!firstName || firstName.length > 50 || !lastName || lastName.length > 50
    || `${firstName} ${lastName}`.length > 100) {
    return response.status(400).json({ error: "El nombre y el apellido deben tener entre 1 y 50 caracteres y no superar 100 caracteres en total." });
  }
  if (phone.length > 20 || !/^\+?[\d\s().-]+$/.test(phone) || phoneDigits.length < 7 || phoneDigits.length > 15) {
    return response.status(400).json({ error: "Ingresa un número telefónico válido." });
  }
  if (!isValidEmail(customerEmail)) {
    return response.status(400).json({ error: "Ingresa un correo electrónico válido." });
  }
  if (Buffer.byteLength(password, "utf8") < 8 || Buffer.byteLength(password, "utf8") > 72) {
    return response.status(400).json({ error: "La contraseña debe tener entre 8 y 72 bytes." });
  }
  if (!isValidPaymentDate(registrationDate)) {
    return response.status(400).json({ error: "Ingresa una fecha de registro válida, que no sea futura." });
  }
  if (!planName || planName.length > 40) {
    return response.status(400).json({ error: "Selecciona un plan válido." });
  }
  if (!getImageSignature(enrollmentProof.mimetype, enrollmentProof.buffer)) {
    return response.status(400).json({ error: "El comprobante debe ser una imagen JPG o PNG válida." });
  }

  let client;
  try {
    await ensureRegisteredCustomersTable();
    const plan = await getPaymentPlanByName(planName);
    if (!plan) return response.status(400).json({ error: "El plan seleccionado ya no está disponible." });
    const enrollmentAmount = Number(plan.enrollmentFee);
    if (!Number.isFinite(enrollmentAmount) || enrollmentAmount < 0) {
      throw new Error(`El plan ${plan.name} tiene un monto de inscripción no válido.`);
    }
    if (plan.period === "Mensualidad") await ensureMembershipTrackingTable();
    const passwordHash = await bcrypt.hash(password, 12);

    client = await database.connect();
    await client.query("BEGIN");
    const customer = await client.query(`
      INSERT INTO gym_registered_customers (
        customer_email, customer_name, enrollment_date, customer_phone, plan_name, customer_password_hash,
        enrollment_amount, enrollment_proof_name, enrollment_proof_mime_type, enrollment_proof_data
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `, [
      customerEmail,
      `${firstName} ${lastName}`,
      registrationDate,
      phone,
      plan.name,
      passwordHash,
      enrollmentAmount,
      enrollmentProof ? path.basename(enrollmentProof.originalname || "comprobante") : null,
      enrollmentProof?.mimetype || null,
      enrollmentProof?.buffer || null,
    ]);

    let membershipId;
    let nextDueDate;
    if (plan.period === "Mensualidad") {
      nextDueDate = getNextMonthlyDate(registrationDate);
      const membership = await client.query(`
        INSERT INTO gym_membership_tracking (
          customer_name, customer_email, plan_name, monthly_amount,
          installments_total, installments_paid, enrollment_date, last_payment_date, next_due_date
        )
        VALUES ($1, $2, $3, $4, 1, 1, $5, $6, $7)
        RETURNING id
      `, [
        `${firstName} ${lastName}`,
        customerEmail,
        plan.name,
        plan.membershipFee,
        registrationDate,
        registrationDate,
        nextDueDate,
      ]);
      membershipId = membership.rows[0].id;
    }

    await client.query("COMMIT");
    return response.status(201).json({
      message: plan.period === "Mensualidad"
        ? `Cliente ${firstName} ${lastName} registrado y agregado al control de mensualidades.`
        : `Cliente ${firstName} ${lastName} registrado. El plan semanal no se agregó al control de mensualidades.`,
      customerId: customer.rows[0].id,
      membershipId,
      nextDueDate,
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("No se pudo revertir el registro del cliente:", rollbackError);
      }
    }
    if (error.code === "23505") {
      return response.status(409).json({ error: "Ya existe un cliente registrado con ese correo electrónico." });
    }
    console.error("No se pudo registrar el cliente:", error);
    return response.status(503).json({ error: "No se pudo registrar el cliente." });
  } finally {
    if (client) client.release();
  }
});

app.put("/api/admin/customers/access", requireAdmin, async (request, response) => {
  const customerEmail = normalizeEmail(request.body?.email);
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  if (!isValidEmail(customerEmail)) {
    return response.status(400).json({ error: "Ingresa un correo electrónico válido." });
  }
  if (Buffer.byteLength(password, "utf8") < 8 || Buffer.byteLength(password, "utf8") > 72) {
    return response.status(400).json({ error: "La contraseña debe tener entre 8 y 72 bytes." });
  }

  try {
    await ensureRegisteredCustomersTable();
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await database.query(`
      UPDATE gym_registered_customers
      SET customer_password_hash = $1, updated_at = NOW()
      WHERE customer_email = $2
      RETURNING customer_name
    `, [passwordHash, customerEmail]);
    if (!result.rowCount) return response.status(404).json({ error: "No se encontró un cliente registrado con ese correo." });
    return response.json({ message: `Acceso de ${result.rows[0].customer_name} actualizado.` });
  } catch (error) {
    console.error("No se pudo actualizar el acceso del cliente:", error);
    return response.status(503).json({ error: "No se pudo actualizar el acceso del cliente." });
  }
});

app.get("/api/admin/customers", requireAdmin, async (request, response) => {
  try {
    await ensureRegisteredCustomersTable();
    const result = await database.query(`
      SELECT customer.id, customer.customer_name, customer.customer_email, customer.customer_phone,
        customer.enrollment_date, customer.plan_name, customer.enrollment_amount,
        customer.enrollment_proof_name,
        (customer.customer_password_hash IS NOT NULL) AS has_customer_password,
        COALESCE(enrolled_plans.plans, ARRAY[]::TEXT[]) AS plans
      FROM gym_registered_customers AS customer
      LEFT JOIN LATERAL (
        SELECT ARRAY_AGG(DISTINCT COALESCE(NULLIF(plan_detail->>'name', ''), payment.plan_name)
          ORDER BY COALESCE(NULLIF(plan_detail->>'name', ''), payment.plan_name)) AS plans
        FROM gym_payment_submissions AS payment
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(payment.plan_details) = 'array'
              THEN CASE
                WHEN jsonb_array_length(payment.plan_details) > 0 THEN payment.plan_details
                ELSE jsonb_build_array(jsonb_build_object('name', payment.plan_name))
              END
            ELSE jsonb_build_array(jsonb_build_object('name', payment.plan_name))
          END
        ) AS plan_detail(value)
        WHERE LOWER(BTRIM(payment.customer_email)) = customer.customer_email
          AND payment.status = 'approved'
          AND payment.payment_type = 'enrollment'
      ) AS enrolled_plans ON TRUE
      ORDER BY customer.customer_name ASC, customer.customer_email ASC
    `);
    return response.json({ customers: result.rows });
  } catch (error) {
    console.error("No se pudieron cargar los clientes inscritos:", error);
    return response.status(503).json({ error: "No se pudieron cargar los clientes inscritos." });
  }
});

app.get("/api/admin/customers/:id/enrollment-proof", requireAdmin, async (request, response) => {
  if (!/^\d+$/.test(request.params.id)) {
    return response.status(400).json({ error: "El identificador del cliente no es válido." });
  }

  try {
    await ensureRegisteredCustomersTable();
    const result = await database.query(`
      SELECT enrollment_proof_name, enrollment_proof_mime_type, enrollment_proof_data
      FROM gym_registered_customers
      WHERE id = $1
    `, [request.params.id]);
    const customer = result.rows[0];
    if (!customer) return response.status(404).json({ error: "No se encontró el cliente registrado." });
    if (!customer.enrollment_proof_data) {
      return response.status(404).json({ error: "Este cliente no tiene un comprobante de inscripción." });
    }
    return response.json({
      proof: {
        name: customer.enrollment_proof_name,
        mimeType: customer.enrollment_proof_mime_type,
        data: customer.enrollment_proof_data.toString("base64"),
      },
    });
  } catch (error) {
    console.error("No se pudo cargar el comprobante de inscripción:", error);
    return response.status(503).json({ error: "No se pudo cargar el comprobante de inscripción." });
  }
});

app.patch("/api/admin/customers/:id", requireAdmin, async (request, response) => {
  if (!/^\d+$/.test(request.params.id)) {
    return response.status(400).json({ error: "El identificador del cliente no es válido." });
  }
  const firstName = typeof request.body?.firstName === "string" ? request.body.firstName.trim() : "";
  const lastName = typeof request.body?.lastName === "string" ? request.body.lastName.trim() : "";
  const phone = typeof request.body?.phone === "string" ? request.body.phone.trim() : "";
  const customerEmail = normalizeEmail(request.body?.email);
  const registrationDate = typeof request.body?.registrationDate === "string"
    ? request.body.registrationDate
    : "";
  const enrollmentAmountInput = typeof request.body?.enrollmentAmount === "string"
    ? request.body.enrollmentAmount
    : "";
  const enrollmentAmount = Number(enrollmentAmountInput);
  const customerName = `${firstName} ${lastName}`.trim();
  const phoneDigits = phone.replace(/\D/g, "");
  if (!firstName || firstName.length > 50 || !lastName || lastName.length > 50
    || customerName.length > 100) {
    return response.status(400).json({ error: "El nombre y los apellidos deben tener entre 1 y 50 caracteres y no superar 100 caracteres en total." });
  }
  if (phone.length > 20 || !/^\+?[\d\s().-]+$/.test(phone) || phoneDigits.length < 7 || phoneDigits.length > 15) {
    return response.status(400).json({ error: "Ingresa un número telefónico válido." });
  }
  if (!isValidEmail(customerEmail)) {
    return response.status(400).json({ error: "Ingresa un correo electrónico válido." });
  }
  if (!isValidPaymentDate(registrationDate)) {
    return response.status(400).json({ error: "Ingresa una fecha de afiliación válida, que no sea futura." });
  }
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(enrollmentAmountInput)
    || !Number.isFinite(enrollmentAmount) || enrollmentAmount < 0) {
    return response.status(400).json({ error: "Ingresa un monto de inscripción válido." });
  }

  let client;
  try {
    await ensureRegisteredCustomersTable();
    await ensureMembershipTrackingTable();
    client = await database.connect();
    await client.query("BEGIN");
    const existingCustomer = await client.query(`
      SELECT customer_email
      FROM gym_registered_customers
      WHERE id = $1
      FOR UPDATE
    `, [request.params.id]);
    if (!existingCustomer.rowCount) {
      await client.query("ROLLBACK");
      return response.status(404).json({ error: "No se encontró el cliente inscrito." });
    }
    await client.query(`
      UPDATE gym_registered_customers
      SET customer_name = $1, customer_phone = $2, customer_email = $3,
        enrollment_date = $4, enrollment_amount = $5, updated_at = NOW()
      WHERE id = $6
    `, [customerName, phone, customerEmail, registrationDate, enrollmentAmount, request.params.id]);
    const membershipResult = await client.query(`
      SELECT id, next_due_date
      FROM gym_membership_tracking
      WHERE LOWER(BTRIM(customer_email)) = LOWER(BTRIM($1))
      FOR UPDATE
    `, [existingCustomer.rows[0].customer_email]);
    for (const membership of membershipResult.rows) {
      const currentDueDate = String(membership.next_due_date).slice(0, 10);
      const nextDueDate = getMonthlyDate(currentDueDate, registrationDate);
      await client.query(`
        UPDATE gym_membership_tracking
        SET customer_name = $1, customer_email = $2, enrollment_date = $3,
          next_due_date = $4, reminder_sent_for = NULL,
          reminder_7_days_sent_for = NULL, reminder_1_day_sent_for = NULL
        WHERE id = $5
      `, [customerName, customerEmail, registrationDate, nextDueDate, membership.id]);
    }
    await client.query(`
      UPDATE gym_payment_submissions
      SET customer_name = $1, customer_email = $2, customer_phone = $3
      WHERE LOWER(BTRIM(customer_email)) = LOWER(BTRIM($4))
        AND payment_type = 'membership'
        AND status = 'pending'
    `, [customerName, customerEmail, phone, existingCustomer.rows[0].customer_email]);
    await client.query("COMMIT");
    return response.json({ message: "Nombre, apellidos, teléfono, correo, fecha de afiliación y monto de inscripción actualizados." });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("No se pudo revertir la actualización del cliente:", rollbackError);
      }
    }
    if (error.code === "23505") {
      return response.status(409).json({ error: "Ya existe otro cliente registrado con ese correo electrónico." });
    }
    console.error("No se pudieron actualizar los datos del cliente inscrito:", error);
    return response.status(503).json({ error: "No se pudieron actualizar los datos del cliente." });
  } finally {
    if (client) client.release();
  }
});

app.delete("/api/admin/customers/:id", requireAdmin, async (request, response) => {
  if (!/^\d+$/.test(request.params.id)) {
    return response.status(400).json({ error: "El identificador del cliente no es válido." });
  }

  let client;
  try {
    await ensureRegisteredCustomersTable();
    await ensureMembershipTrackingTable();
    client = await database.connect();
    await client.query("BEGIN");
    const result = await client.query(`
      DELETE FROM gym_registered_customers
      WHERE id = $1
      RETURNING customer_name, customer_email
    `, [request.params.id]);
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return response.status(404).json({ error: "No se encontró el cliente registrado." });
    }

    await client.query(`
      DELETE FROM gym_membership_tracking
      WHERE LOWER(BTRIM(customer_email)) = LOWER(BTRIM($1))
    `, [result.rows[0].customer_email]);
    await client.query("COMMIT");
    return response.json({
      message: `Cliente ${result.rows[0].customer_name} eliminado y retirado del control de mensualidades. El historial de pagos se conservó.`,
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("No se pudo revertir la eliminación del cliente:", rollbackError);
      }
    }
    console.error("No se pudo eliminar al cliente registrado:", error);
    return response.status(503).json({ error: "No se pudo eliminar al cliente registrado." });
  } finally {
    if (client) client.release();
  }
});

app.get("/api/admin/memberships", requireAdmin, async (request, response) => {
  try {
    await ensureMembershipTrackingTable();
    const result = await database.query(`
      SELECT id, customer_name, customer_email, plan_name, monthly_amount,
        enrollment_date, last_payment_date, next_due_date,
        reminder_7_days_sent_for = next_due_date AS reminder_7_days_sent,
        reminder_1_day_sent_for = next_due_date AS reminder_1_day_sent,
        gym_access_restricted,
        GREATEST(
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Caracas')::date - next_due_date,
          0
        ) AS days_overdue,
        CASE
          WHEN next_due_date < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Caracas')::date THEN 'overdue'
          WHEN next_due_date = (CURRENT_TIMESTAMP AT TIME ZONE 'America/Caracas')::date THEN 'due_today'
          ELSE 'current'
        END AS payment_status
      FROM gym_membership_tracking
      ORDER BY next_due_date ASC, customer_name ASC
    `);
    return response.json({ memberships: result.rows });
  } catch (error) {
    console.error("No se pudo cargar el control de mensualidades:", error);
    return response.status(503).json({ error: "No se pudo cargar el control de mensualidades." });
  }
});

app.patch("/api/admin/memberships/:id/access", requireAdmin, async (request, response) => {
  if (!/^\d+$/.test(request.params.id)) {
    return response.status(400).json({ error: "El identificador del cliente no es válido." });
  }
  if (typeof request.body?.restricted !== "boolean") {
    return response.status(400).json({ error: "Indica si se debe restringir o habilitar el acceso." });
  }

  try {
    await ensureMembershipTrackingTable();
    const result = await database.query(`
      UPDATE gym_membership_tracking
      SET gym_access_restricted = $2,
        gym_access_restricted_at = CASE WHEN $2 THEN NOW() ELSE NULL END
      WHERE id = $1
        AND (
          NOT $2
          OR (CURRENT_TIMESTAMP AT TIME ZONE 'America/Caracas')::date - next_due_date > 5
        )
      RETURNING customer_name
    `, [request.params.id, request.body.restricted]);

    if (!result.rowCount) {
      const membershipExists = await database.query(
        "SELECT 1 FROM gym_membership_tracking WHERE id = $1",
        [request.params.id],
      );
      if (!membershipExists.rowCount) {
        return response.status(404).json({ error: "No se encontró al cliente en el control de mensualidades." });
      }
      return response.status(409).json({
        error: "Solo se puede restringir el acceso cuando han pasado más de 5 días desde el vencimiento.",
      });
    }

    return response.json({
      message: request.body.restricted
        ? `Acceso al gimnasio restringido para ${result.rows[0].customer_name}.`
        : `Acceso al gimnasio habilitado para ${result.rows[0].customer_name}.`,
    });
  } catch (error) {
    console.error("No se pudo actualizar la restricción de acceso al gimnasio:", error);
    return response.status(503).json({ error: "No se pudo actualizar el acceso al gimnasio." });
  }
});

app.delete("/api/admin/memberships/:id", requireAdmin, async (request, response) => {
  if (!/^\d+$/.test(request.params.id)) {
    return response.status(400).json({ error: "El identificador del cliente no es válido." });
  }

  try {
    await ensureMembershipTrackingTable();
    const result = await database.query(
      "DELETE FROM gym_membership_tracking WHERE id = $1 RETURNING customer_name",
      [request.params.id],
    );
    if (!result.rowCount) {
      return response.status(404).json({ error: "No se encontró el cliente en el control de mensualidades." });
    }
    return response.json({
      message: `${result.rows[0].customer_name} fue eliminado del control de mensualidades.`,
    });
  } catch (error) {
    console.error("No se pudo eliminar el cliente del control de mensualidades:", error);
    return response.status(503).json({ error: "No se pudo eliminar al cliente del control de mensualidades." });
  }
});

app.post("/api/admin/memberships", requireAdmin, async (request, response) => {
  const customerName = typeof request.body?.customerName === "string" ? request.body.customerName.trim() : "";
  const customerEmail = normalizeEmail(request.body?.customerEmail);
  const planName = typeof request.body?.planName === "string" ? request.body.planName : "";
  const paymentDate = typeof request.body?.paymentDate === "string" ? request.body.paymentDate : "";

  if (!customerName || customerName.length > 100 || !isValidEmail(customerEmail)
    || !planName || !isValidPaymentDate(paymentDate)) {
    return response.status(400).json({ error: "Verifica el nombre, correo, plan y fecha del pago." });
  }

  try {
    const selectedPlan = await getPaymentPlanByName(planName);
    if (!selectedPlan) {
      return response.status(400).json({ error: "Selecciona un plan válido." });
    }
    await ensureMembershipTrackingTable();
    const customer = await database.query(`
      SELECT enrollment_date
      FROM gym_registered_customers
      WHERE LOWER(BTRIM(customer_email)) = LOWER(BTRIM($1))
      LIMIT 1
    `, [customerEmail]);
    const enrollmentDate = customer.rows[0]
      ? String(customer.rows[0].enrollment_date).slice(0, 10)
      : paymentDate;
    const nextDueDate = getNextMonthlyDate(paymentDate, enrollmentDate);
    const result = await database.query(`
      INSERT INTO gym_membership_tracking (
        customer_name, customer_email, plan_name, monthly_amount,
        installments_total, installments_paid, enrollment_date, last_payment_date, next_due_date
      )
      VALUES ($1, $2, $3, $4, 1, 1, $5, $6, $7)
      RETURNING id
    `, [
      customerName,
      customerEmail,
      planName,
      selectedPlan.membershipFee,
      paymentDate,
      paymentDate,
      nextDueDate,
    ]);
    return response.status(201).json({
      message: "Cliente agregado al control de mensualidades.",
      membershipId: result.rows[0].id,
      nextDueDate,
    });
  } catch (error) {
    console.error("No se pudo guardar el control de mensualidades:", error);
    return response.status(503).json({ error: "No se pudo guardar el control de mensualidades." });
  }
});

app.post("/api/admin/memberships/:id/reminder", requireAdmin, async (request, response) => {
  if (!/^\d+$/.test(request.params.id)) {
    return response.status(400).json({ error: "El identificador del cliente no es válido." });
  }

  let client;
  try {
    await ensureMembershipTrackingTable();
    client = await database.connect();
    await client.query("BEGIN");
    const result = await client.query(`
      SELECT id, customer_name, customer_email, plan_name, monthly_amount,
        next_due_date, reminder_sent_for,
        reminder_7_days_sent_for, reminder_1_day_sent_for,
        (CURRENT_TIMESTAMP AT TIME ZONE 'America/Caracas')::date::text AS today,
        ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Caracas')::date + 7)::text AS reminder_limit,
        (((CURRENT_TIMESTAMP AT TIME ZONE 'America/Caracas')::date + 7) = next_due_date) AS is_seven_day_reminder,
        (((CURRENT_TIMESTAMP AT TIME ZONE 'America/Caracas')::date + 1) = next_due_date) AS is_one_day_reminder
      FROM gym_membership_tracking
      WHERE id = $1
      FOR UPDATE
    `, [request.params.id]);
    const membership = result.rows[0];
    if (!membership) {
      await client.query("ROLLBACK");
      return response.status(404).json({ error: "No se encontró el cliente en el control de mensualidades." });
    }
    const dueDate = String(membership.next_due_date).slice(0, 10);
    if (dueDate < membership.today || dueDate > membership.reminder_limit) {
      await client.query("ROLLBACK");
      return response.status(409).json({ error: "Solo se puede avisar sobre pagos que vencen en los próximos 7 días." });
    }
    const daysBeforeDue = membership.is_seven_day_reminder ? 7 : membership.is_one_day_reminder ? 1 : null;
    const reminderAlreadySent = daysBeforeDue === 7
      ? String(membership.reminder_7_days_sent_for).slice(0, 10) === dueDate
      : daysBeforeDue === 1
        ? String(membership.reminder_1_day_sent_for).slice(0, 10) === dueDate
        : String(membership.reminder_sent_for).slice(0, 10) === dueDate;
    if (reminderAlreadySent) {
      await client.query("ROLLBACK");
      return response.status(409).json({ error: "Ya se envió el recordatorio correspondiente a esta fecha." });
    }

    await sendMembershipReminder(membership, daysBeforeDue);
    const reminderColumn = daysBeforeDue === 7
      ? "reminder_7_days_sent_for"
      : daysBeforeDue === 1
        ? "reminder_1_day_sent_for"
        : "reminder_sent_for";
    await client.query(
      `UPDATE gym_membership_tracking SET ${reminderColumn} = next_due_date WHERE id = $1`,
      [membership.id],
    );
    await client.query("COMMIT");
    return response.json({ message: `Aviso enviado a ${membership.customer_email}.` });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("No se pudo revertir el envío del aviso de mensualidad:", rollbackError);
      }
    }
    console.error("No se pudo enviar el aviso de mensualidad:", error);
    return response.status(503).json({ error: "No se pudo enviar el aviso. Verifica la configuración del correo e inténtalo de nuevo." });
  } finally {
    if (client) client.release();
  }
});

app.post("/api/admin/memberships/:id/payments", requireAdmin, async (request, response) => {
  if (!/^\d+$/.test(request.params.id)) {
    return response.status(400).json({ error: "El identificador del cliente no es válido." });
  }
  const paymentDate = typeof request.body?.paymentDate === "string" ? request.body.paymentDate : "";
  if (!isValidPaymentDate(paymentDate)) {
    return response.status(400).json({ error: "La fecha del pago no es válida." });
  }

  let client;
  try {
    await ensureMembershipTrackingTable();
    client = await database.connect();
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT enrollment_date, last_payment_date, next_due_date FROM gym_membership_tracking WHERE id = $1 FOR UPDATE",
      [request.params.id],
    );
    const membership = result.rows[0];
    if (!membership) {
      await client.query("ROLLBACK");
      return response.status(404).json({ error: "No se encontró el cliente en el control de mensualidades." });
    }
    if (paymentDate <= membership.last_payment_date) {
      await client.query("ROLLBACK");
      return response.status(400).json({ error: "La fecha del pago debe ser posterior al último pago registrado." });
    }

    const nextDueDate = getNextMonthlyDate(
      String(membership.next_due_date).slice(0, 10),
      String(membership.enrollment_date).slice(0, 10),
    );
    await client.query(`
      UPDATE gym_membership_tracking
      SET last_payment_date = $1,
        next_due_date = $2,
        reminder_sent_for = NULL,
        reminder_7_days_sent_for = NULL,
        reminder_1_day_sent_for = NULL
      WHERE id = $3
    `, [paymentDate, nextDueDate, request.params.id]);
    await client.query("COMMIT");
    return response.json({
      message: "Mensualidad registrada.",
      nextDueDate,
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("No se pudo revertir el registro de mensualidad:", rollbackError);
      }
    }
    console.error("No se pudo registrar la mensualidad:", error);
    return response.status(503).json({ error: "No se pudo registrar la mensualidad." });
  } finally {
    if (client) client.release();
  }
});

app.get("/api/admin/payments", requireAdmin, async (request, response) => {
  const status = request.query.status || "pending";
  const type = request.query.type || "all";
  if (!["pending", "approved", "all"].includes(status)
    || !["enrollment", "membership", "all"].includes(type)) {
    return response.status(400).json({ error: "El filtro de pagos no es válido." });
  }

  try {
    await ensurePaymentsTable();
    const conditions = [];
    const values = [];
    if (status !== "all") {
      values.push(status);
      conditions.push(`status = $${values.length}`);
    }
    if (type !== "all") {
      values.push(type);
      conditions.push(`payment_type = $${values.length}`);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await database.query(`
        SELECT id, customer_name, customer_email, customer_phone, payment_date,
          plan_name, payment_type, payment_method, status, submitted_at, approved_at
        FROM gym_payment_submissions
        ${whereClause}
        ORDER BY submitted_at DESC
        LIMIT 200
      `, values);
    return response.json({ payments: result.rows });
  } catch (error) {
    console.error("No se pudieron cargar los comprobantes para administración:", error);
    return response.status(503).json({ error: "No se pudieron cargar los comprobantes de pago." });
  }
});

app.get("/api/admin/payments/:id", requireAdmin, async (request, response) => {
  if (!/^\d+$/.test(request.params.id)) {
    return response.status(400).json({ error: "El identificador del pago no es válido." });
  }

  try {
    await ensurePaymentsTable();
    const result = await database.query(`
      SELECT id, customer_name, customer_email, customer_phone, payment_date,
        plan_name, payment_type, plan_details, enrollment_fee, membership_fee, plan_period,
        plan_image_name, plan_image_mime_type, plan_image_data, payment_method,
        receipt_name, receipt_mime_type, receipt_data,
        status, submitted_at, approved_at
      FROM gym_payment_submissions
      WHERE id = $1
    `, [request.params.id]);
    const payment = result.rows[0];
    if (!payment) return response.status(404).json({ error: "No se encontró el comprobante." });
    const plans = await getPlansForSubmission(payment);
    if (!plans.length) throw new Error(`El pago ${payment.id} tiene planes no reconocidos.`);
    const paymentAmount = getPaymentFeeRows(payment, plans)
      .reduce((sum, row) => sum + row.amount, 0);

    return response.json({
      payment: {
        ...payment,
        plans: plans.map(({ name, enrollmentFee, membershipFee, period }) => ({
          name,
          enrollmentFee,
          membershipFee,
          period,
        })),
        payment_amount: paymentAmount,
        receipt_data: payment.receipt_data.toString("base64"),
      },
    });
  } catch (error) {
    console.error("No se pudo cargar el comprobante solicitado:", error);
    return response.status(503).json({ error: "No se pudo abrir el comprobante de pago." });
  }
});

app.post("/api/admin/payments/:id/approve", requireAdmin, async (request, response) => {
  if (!/^\d+$/.test(request.params.id)) {
    return response.status(400).json({ error: "El identificador del pago no es válido." });
  }

  let client;
  try {
    await ensurePaymentsTable();
    await ensureRegisteredCustomersTable();
    client = await database.connect();
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT * FROM gym_payment_submissions WHERE id = $1 FOR UPDATE",
      [request.params.id],
    );
    const payment = result.rows[0];
    if (!payment) {
      await client.query("ROLLBACK");
      return response.status(404).json({ error: "No se encontró el comprobante." });
    }
    if (payment.status === "approved") {
      await client.query("ROLLBACK");
      return response.status(409).json({ error: "Este pago ya fue aprobado." });
    }

    let membership;
    let nextDueDate;
    if (payment.payment_type === "membership") {
      await ensureMembershipTrackingTable();
      const membershipResult = await client.query(`
        SELECT id, customer_name, customer_email, plan_name, enrollment_date,
          last_payment_date, next_due_date
        FROM gym_membership_tracking
        WHERE LOWER(BTRIM(customer_email)) = LOWER(BTRIM($1))
          AND LOWER(BTRIM(plan_name)) = LOWER(BTRIM($2))
        FOR UPDATE
      `, [payment.customer_email, payment.plan_name]);
      if (!membershipResult.rowCount) {
        await client.query("ROLLBACK");
        return response.status(409).json({
          error: "No se encontró esta mensualidad en el control. Agrega al cliente y su plan al control antes de aprobar el comprobante.",
        });
      }
      if (membershipResult.rowCount > 1) {
        await client.query("ROLLBACK");
        return response.status(409).json({
          error: "Hay más de una mensualidad asociada al correo y plan. Corrige el control antes de aprobar el comprobante.",
        });
      }
      membership = membershipResult.rows[0];
      if (String(payment.payment_date).slice(0, 10) <= String(membership.last_payment_date).slice(0, 10)) {
        await client.query("ROLLBACK");
        return response.status(409).json({
          error: "La fecha del comprobante debe ser posterior al último pago registrado en el control.",
        });
      }
      nextDueDate = getNextMonthlyDate(
        String(membership.next_due_date).slice(0, 10),
        String(membership.enrollment_date).slice(0, 10),
      );
    }

    const plans = await getPlansForSubmission(payment);
    if (!plans.length) throw new Error(`El pago ${payment.id} tiene planes no reconocidos.`);

    let mailer;
    try {
      mailer = createMailer();
    } catch (error) {
      console.error("No se puede enviar el correo de aprobación:", error);
      await client.query("ROLLBACK");
      return response.status(503).json({ error: "Configura el correo SMTP antes de aprobar pagos." });
    }

    const invoiceDate = new Date().toLocaleDateString("es-VE");
    const invoicePdf = await buildInvoicePdf(payment, plans, invoiceDate);
    const feeRows = getPaymentFeeRows(payment, plans).map((row) =>
      `<tr><td>${escapeHtml(row.label)}</td><td>$${row.amount.toFixed(2)} USD</td></tr>`);
    const totalAmount = getPaymentFeeRows(payment, plans)
      .reduce((sum, row) => sum + row.amount, 0);
    const total = totalAmount.toFixed(2);
    const planNames = plans.map((plan) => plan.name).join(", ");
    const primaryPlan = plans[0];
    const formattedNextDueDate = nextDueDate
      ? new Date(`${nextDueDate}T00:00:00.000Z`).toLocaleDateString("es-VE", { timeZone: "UTC" })
      : "";
    const membershipConfirmation = payment.payment_type === "membership"
      ? "Tu pago ya fue verificado y aprobado. Si tu acceso a las instalaciones estaba restringido, la administración debe habilitarlo manualmente."
      : "";

    await mailer.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: payment.customer_email,
      subject: payment.payment_type === "membership"
        ? "Tu pago de mensualidad fue aprobado - Esmeralda Gym"
        : "Tu pago fue aprobado - Esmeralda Gym",
      text: payment.payment_type === "membership"
        ? `Hola ${payment.customer_name}, tu pago de mensualidad fue aprobado con éxito. ${membershipConfirmation} Tu próximo pago vence el ${formattedNextDueDate}. Adjuntamos la factura de ${planNames} por $${total} USD.\n\nESMERALDA GYM Donde el alma sonrie`
        : `Hola ${payment.customer_name}, tu pago fue aprobado exitosamente. Adjuntamos la factura de ${planNames} por $${total} USD.`,
      html: `<!doctype html><html lang="es"><body style="margin:0;padding:24px;background:#f3f6f3;font-family:Arial,sans-serif;color:#17231c">
        <main style="max-width:620px;margin:auto;padding:28px;background:#fff;border-top:5px solid #b4d83e">
          <p style="margin:0;color:#167446;font-weight:bold;letter-spacing:2px">ESMERALDA GYM</p>
          <h1 style="color:#10251b">${payment.payment_type === "membership" ? "¡Tu pago de mensualidad fue aprobado con éxito!" : "¡Pago aprobado exitosamente!"}</h1>
          <p>Hola ${escapeHtml(payment.customer_name)}, ${payment.payment_type === "membership" ? `confirmamos que tu pago de mensualidad fue aprobado con éxito. ${escapeHtml(membershipConfirmation)} Tu próximo pago vence el <strong>${escapeHtml(formattedNextDueDate)}</strong>.` : "confirmamos que tu pago fue aprobado. Gracias por elegir Esmeralda Gym."}</p>
          <h2 style="color:#167446">${escapeHtml(planNames)}</h2>
          <img src="cid:plan-image" alt="${escapeHtml(primaryPlan.name)}" style="display:block;width:100%;max-width:360px;height:auto;margin:16px 0">
          <table style="width:100%;border-collapse:collapse">
            ${feeRows.join("")}
            <tr style="font-weight:bold;border-top:2px solid #167446"><td style="padding-top:12px">Total pagado</td><td style="padding-top:12px">$${total} USD</td></tr>
          </table>
          <p>Adjuntamos tu factura en PDF. Conserva este correo como constancia de aprobación.</p>
          ${payment.payment_type === "membership" ? '<p style="margin-top:24px;color:#167446;font-size:18px;font-weight:bold">ESMERALDA GYM Donde el alma sonrie</p>' : ""}
        </main>
      </body></html>`,
      attachments: [
        {
          filename: `factura-esmeralda-gym-${payment.id}.pdf`,
          content: invoicePdf,
          contentType: "application/pdf",
        },
        {
          filename: path.basename(primaryPlan.image),
          ...(primaryPlan.imageData
            ? { content: primaryPlan.imageData, contentType: primaryPlan.imageMimeType }
            : { path: path.join(__dirname, "images_planes", primaryPlan.image) }),
          cid: "plan-image",
        },
      ],
    });

    if (membership) {
      await client.query(`
        UPDATE gym_membership_tracking
          SET last_payment_date = $1,
            next_due_date = $2,
          reminder_sent_for = NULL,
          reminder_7_days_sent_for = NULL,
          reminder_1_day_sent_for = NULL
          WHERE id = $3
      `, [payment.payment_date, nextDueDate, membership.id]);
    }
    await client.query(
      "UPDATE gym_payment_submissions SET status = 'approved', approved_at = NOW() WHERE id = $1",
      [payment.id],
    );
    await client.query("COMMIT");
    return response.json({
      message: payment.payment_type === "membership"
        ? `Mensualidad aprobada, próximo vencimiento actualizado al ${formattedNextDueDate}. Si el acceso estaba restringido, administración debe habilitarlo manualmente.`
        : "Pago aprobado y factura enviada al correo del cliente.",
    });
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("No se pudo revertir la aprobación del pago:", rollbackError);
      }
    }
    console.error("No se pudo aprobar el pago o enviar su factura:", error);
    return response.status(503).json({ error: "No se pudo completar la aprobación ni enviar la factura." });
  } finally {
    if (client) client.release();
  }
});

app.post("/api/pagos.js", (request, response, next) => {
  paymentUpload.single("receipt")(request, response, (error) => {
    if (error) {
      const tooLarge = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
      return response.status(tooLarge ? 413 : 400).json({
        error: tooLarge
          ? "El comprobante excede el límite de 8 MB."
          : "No se pudo procesar el comprobante enviado.",
      });
    }
    return next();
  });
}, requireCustomerForMembershipPayment, async (request, response) => {
  const paymentType = typeof request.body?.paymentType === "string" ? request.body.paymentType : "enrollment";
  let name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
  let email = normalizeEmail(request.body?.email);
  let phone = typeof request.body?.phone === "string" ? request.body.phone.trim() : "";
  const paymentDate = typeof request.body?.paymentDate === "string" ? request.body.paymentDate : "";
  let planName = typeof request.body?.planName === "string" ? request.body.planName : "";
  const submittedPlanNames = request.body?.planNames;
  let planNames = paymentType === "membership"
    ? [planName]
    : (Array.isArray(submittedPlanNames) ? submittedPlanNames : [submittedPlanNames || planName]);
  const receipt = request.file;

  if (paymentType === "membership") {
    try {
      await ensureRegisteredCustomersTable();
      const result = await database.query(`
        SELECT customer_name, customer_email, customer_phone, plan_name
        FROM gym_registered_customers
        WHERE id = $1
        LIMIT 1
      `, [request.customerId]);
      if (!result.rowCount) return response.status(401).json({ error: "No se encontró la cuenta del cliente. Inicia sesión de nuevo." });
      const customer = result.rows[0];
      name = customer.customer_name;
      email = customer.customer_email;
      phone = customer.customer_phone || "";
      planName = customer.plan_name || "";
      planNames = [planName];
    } catch (error) {
      console.error("No se pudo validar la cuenta para el pago de mensualidad:", error);
      return response.status(503).json({ error: "No se pudo validar la cuenta para el pago." });
    }
  }

  const parsedPaymentDate = new Date(`${paymentDate}T00:00:00.000Z`);
  const validPaymentDate = /^\d{4}-\d{2}-\d{2}$/.test(paymentDate)
    && !Number.isNaN(parsedPaymentDate.valueOf())
    && parsedPaymentDate.toISOString().slice(0, 10) === paymentDate
    && parsedPaymentDate <= new Date();

  if (!name || name.length > 100 || !isValidEmail(email)
    || !/^[0-9+() .-]{7,20}$/.test(phone)
    || !validPaymentDate
    || planNames.length < 1 || planNames.length > 6
    || planNames.some((name) => typeof name !== "string" || !name.trim())
    || new Set(planNames).size !== planNames.length
    || !["enrollment", "membership"].includes(paymentType)
    || !receipt) {
    return response.status(400).json({ error: "Verifica los datos del pago, selecciona un plan y adjunta el comprobante." });
  }

  const fileSignatures = {
    "image/jpeg": receipt.buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
    "image/png": receipt.buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "application/pdf": receipt.buffer.subarray(0, 5).toString() === "%PDF-",
  };
  if (!fileSignatures[receipt.mimetype]) {
    return response.status(400).json({ error: "El comprobante debe ser una imagen JPG, PNG o un archivo PDF válido." });
  }

  try {
    const selectedPlans = await Promise.all(planNames.map((name) => getPaymentPlanByName(name)));
    if (selectedPlans.some((plan) => !plan)) {
      return response.status(400).json({ error: "Uno o más planes seleccionados ya no están disponibles." });
    }
    if (paymentType === "membership" && selectedPlans.some((plan) => plan.period !== "Mensualidad")) {
      return response.status(400).json({ error: "El plan registrado no permite enviar un pago de mensualidad." });
    }
    const [primaryPlan] = selectedPlans;
    const planDetails = selectedPlans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      enrollmentFee: plan.enrollmentFee,
      membershipFee: plan.membershipFee,
      period: plan.period,
      image: plan.image,
    }));
    const combinedPlanName = selectedPlans.map((plan) => plan.name).join(", ");
    await ensurePaymentsTable();
    const result = await database.query(`
      INSERT INTO gym_payment_submissions (
        customer_name, customer_email, customer_phone, payment_date, plan_name, payment_type, plan_details,
        enrollment_fee, membership_fee, plan_period, plan_image_name, plan_image_mime_type,
        plan_image_data, payment_method, receipt_name, receipt_mime_type, receipt_data
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, 'Pago Móvil', $14, $15, $16)
      RETURNING id
    `, [
      name,
      email,
      phone,
      paymentDate,
      combinedPlanName,
      paymentType,
      JSON.stringify(planDetails),
      primaryPlan.enrollmentFee,
      primaryPlan.membershipFee,
      primaryPlan.period,
      primaryPlan.image,
      primaryPlan.imageMimeType,
      primaryPlan.imageData,
      path.basename(receipt.originalname || "comprobante"),
      receipt.mimetype,
      receipt.buffer,
    ]);
    return response.status(201).json({
      message: "Comprobante recibido. Espera la confirmación de tu pago.",
      paymentId: result.rows[0].id,
    });
  } catch (error) {
    console.error("No se pudo guardar el comprobante de pago:", error);
    return response.status(503).json({ error: "No se pudo guardar el comprobante. Inténtalo de nuevo." });
  }
});

app.use("/api", express.raw({ type: "*/*", limit: "10mb" }));
app.use("/api", async (request, response) => {
  if (!backendUrl) {
    return response.status(503).json({ error: "BACKEND_URL no está configurada" });
  }

  try {
    const targetUrl = new URL(request.originalUrl, backendUrl);
    const headers = new Headers();

    for (const name of ["accept", "content-type", "authorization"]) {
      const value = request.get(name);
      if (value) headers.set(name, value);
    }

    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method)
        ? undefined
        : Buffer.isBuffer(request.body) || typeof request.body === "string"
          ? request.body
          : request.body === undefined ? undefined : JSON.stringify(request.body),
    });
    const contentType = upstream.headers.get("content-type");

    if (contentType) response.set("content-type", contentType);
    response.status(upstream.status);
    return response.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    return response.status(502).json({ error: "No se pudo conectar con el backend" });
  }
});

app.get("/", (request, response) => {
  return response.redirect("/app");
});

app.get("/login", (request, response) => {
  return response.redirect("/app");
});

app.get("/style.css", (request, response) => {
  response.sendFile(path.join(__dirname, "views", "style.css"));
});

app.get("/app", async (request, response) => {
  try {
    const plans = await getPaymentPlans();
    const paymentSettings = await getPaymentSettings();
    const availablePlans = plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      description: plan.description,
      benefits: plan.benefits,
      enrollmentFee: plan.enrollmentFee,
      membershipFee: plan.membershipFee,
      period: plan.period,
      imageUrl: `/plan-images/${plan.id}`,
    }));
    const availablePlansJson = JSON.stringify(availablePlans).replace(/</g, "\\u003c");
    return response.render("index", { availablePlans, availablePlansJson, paymentSettings });
  } catch (error) {
    console.error("No se pudieron cargar los planes para el menú de clientes:", error);
    return response.status(503).send("No se pudieron cargar los planes. Inténtalo de nuevo más tarde.");
  }
});

app.get("/admin", (request, response) => {
  response.render("admin");
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  refreshBcvRate().catch((error) => {
    console.error("No se pudo cargar la tasa oficial del BCV al iniciar:", error);
  });
  setInterval(() => {
    refreshBcvRate().catch((error) => {
      console.error("No se pudo actualizar automáticamente la tasa oficial del BCV:", error);
    });
  }, bcvRateCacheTtlMs);
  const checkMembershipReminders = () => {
    sendDueMembershipReminders().catch((error) => {
      console.error("No se pudieron enviar los recordatorios de mensualidad:", error);
    });
  };
  checkMembershipReminders();
  setInterval(checkMembershipReminders, 5 * 60 * 1000);
});