const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');

const PROMPT_RECEITA = `Você vai receber a foto de uma receita médica. Extraia cada medicamento
prescrito e devolva SOMENTE um JSON válido, sem nenhum texto antes ou
depois, no formato:

{
  "medicamentos": [
    {
      "nome": "string",
      "dosagem": "string, ex: 50mg, 1 comprimido",
      "via_administracao": "string, ex: oral, com água, em jejum",
      "frequencia": "string, ex: a cada 8 horas, 1x ao dia",
      "duracao_dias": number,
      "horarios": ["HH:mm", "HH:mm"]
    }
  ]
}

Se algum campo não estiver legível ou não constar na receita, use null
para esse campo em vez de adivinhar. Não invente informações que não
estão escritas na receita.`;

/**
 * Callable function: o app Flutter chama isso via
 * FirebaseFunctions.instance.httpsCallable('lerReceita').
 */
exports.lerReceita = onCall(
  { secrets: [anthropicApiKey], timeoutSeconds: 30 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        'unauthenticated',
        'É preciso estar autenticado para enviar uma receita.'
      );
    }

    const base64Imagem = request.data?.imagemBase64;
    if (!base64Imagem) {
      throw new HttpsError('invalid-argument', 'Imagem da receita não enviada.');
    }

    const resposta = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey.value(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: base64Imagem,
                },
              },
              { type: 'text', text: PROMPT_RECEITA },
            ],
          },
        ],
      }),
    });

    if (!resposta.ok) {
      console.error('Erro da API de IA:', resposta.status, await resposta.text());
      throw new HttpsError(
        'internal',
        'Não foi possível processar a receita. Tente novamente.'
      );
    }

    const corpo = await resposta.json();
    const texto = corpo.content
      .filter((bloco) => bloco.type === 'text')
      .map((bloco) => bloco.text)
      .join('');

    const textoLimpo = texto.replace(/```json|```/g, '').trim();

    let json;
    try {
      json = JSON.parse(textoLimpo);
    } catch (erro) {
      console.error('JSON inválido retornado pela IA:', texto);
      throw new HttpsError(
        'internal',
        'A leitura da receita não ficou clara. Tente outra foto.'
      );
    }

    return json;
  }
);

/**
 * Disparado quando o app cria um documento em "alertas_cuidador".
 */
exports.avisarCuidadorDosePerdida = onDocumentCreated(
  'alertas_cuidador/{alertaId}',
  async (event) => {
    const alerta = event.data.data();
    const alertaRef = event.data.ref;

    if (alerta.enviado) return;

    try {
      const horarioSnap = await db
        .collection('horario')
        .doc(alerta.horario_id)
        .get();

      if (!horarioSnap.exists) {
        console.error(`Horário ${alerta.horario_id} não encontrado`);
        return;
      }

      const horario = horarioSnap.data();

      const medicamentoSnap = await db
        .collection('medicamento')
        .doc(horario.medicamento_id)
        .get();
      const medicamento = medicamentoSnap.data();

      const receitaSnap = await db
        .collection('receita')
        .doc(medicamento.receita_id)
        .get();
      const receita = receitaSnap.data();

      const pacienteId = receita.paciente_id;

      const vinculosSnap = await db
        .collection('vinculo_cuidador')
        .where('paciente_id', '==', pacienteId)
        .where('ativo', '==', true)
        .get();

      if (vinculosSnap.empty) {
        console.log(`Paciente ${pacienteId} não tem cuidador vinculado`);
        await alertaRef.update({ enviado: true, motivo: 'sem_cuidador' });
        return;
      }

      const pacienteSnap = await db.collection('paciente').doc(pacienteId).get();
      const paciente = pacienteSnap.data();

      const envios = vinculosSnap.docs.map(async (vinculoDoc) => {
        const vinculo = vinculoDoc.data();
        const cuidadorSnap = await db
          .collection('cuidador')
          .doc(vinculo.cuidador_id)
          .get();
        const cuidador = cuidadorSnap.data();

        if (!cuidador?.fcm_token) return;

        return messaging.send({
          token: cuidador.fcm_token,
          notification: {
            title: `${paciente.nome} não confirmou uma dose`,
            body: `${medicamento.nome} (${medicamento.dosagem}) — horário ${horario.hora}`,
          },
          data: {
            tipo: 'dose_perdida',
            paciente_id: pacienteId,
            medicamento_id: horario.medicamento_id,
            horario_id: alerta.horario_id,
          },
        });
      });

      await Promise.all(envios);
      await alertaRef.update({ enviado: true, enviado_em: new Date() });
    } catch (erro) {
      console.error('Erro ao enviar alerta ao cuidador:', erro);
      await alertaRef.update({ enviado: false, erro: String(erro) });
    }
  }
);

/**
 * Roda a cada 5 minutos, contando tentativas e avisando o cuidador quando
 * uma dose fica sem confirmação após 3 tentativas.
 */
exports.verificarDosesPendentes = onSchedule('every 5 minutes', async () => {
  const MAX_TENTATIVAS = 3;
  const agora = new Date();
  const limite = new Date(agora.getTime() - 15 * 60 * 1000);

  const snapshot = await db
    .collection('dose_registro')
    .where('status', '==', 'pendente')
    .where('data_hora_prevista', '<=', limite)
    .get();

  for (const doc of snapshot.docs) {
    const dados = doc.data();
    const tentativas = dados.tentativas || 0;

    if (tentativas < MAX_TENTATIVAS) {
      await doc.ref.update({ tentativas: tentativas + 1 });
    } else {
      await doc.ref.update({ status: 'perdida' });
      await db.collection('alertas_cuidador').add({
        dose_registro_id: doc.id,
        horario_id: dados.horario_id,
        criado_em: new Date(),
        enviado: false,
      });
    }
  }

  console.log(`Verificação concluída: ${snapshot.size} doses pendentes revisadas`);
});
