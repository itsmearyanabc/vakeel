-- =============================================================================
-- 0006_seed_statutes.sql
-- Starter statute set: the sections advocates look up most, plus the IPC->BNS
-- and CrPC->BNSS mappings that dominate queries since the 2023 recodification.
--
-- ## Read this before going live
--
-- The `section_text` values below are ABRIDGED summaries, not the enacted text.
-- They exist so the bot has something real to answer with on day one and so the
-- citation guardrail has a corpus to validate against.
--
-- Before production, replace them with authoritative full text from
-- indiacode.nic.in via `npm run seed:statutes -- --file <path>`, which upserts
-- on (act_code, section_number, language). Nothing here is load-bearing - the
-- seed is designed to be overwritten.
--
-- `embedding` is intentionally left NULL. Run `npm run ingest -- --statutes` to
-- backfill vectors once you have an embedding provider configured; until then
-- statute lookup still works, because it goes through the lexical and exact
-- match paths in search_statutes(), not dense retrieval.
-- =============================================================================

INSERT INTO statutes (
    act_code, act_name, section_number, section_title, section_text,
    punishment, is_cognizable, is_bailable, is_compoundable, triable_by,
    corresponding_act, corresponding_section, chapter
) VALUES

-- ============================ INDIAN PENAL CODE =============================
('IPC', 'Indian Penal Code, 1860', '299', 'Culpable homicide',
 'Whoever causes death by doing an act with the intention of causing death, or with the intention of causing such bodily injury as is likely to cause death, or with the knowledge that he is likely by such act to cause death, commits the offence of culpable homicide. This is a definitional section; punishment is provided by section 304.',
 NULL, NULL, NULL, NULL, NULL,
 'BNS', '100', 'Chapter XVI - Of Offences Affecting the Human Body'),

('IPC', 'Indian Penal Code, 1860', '300', 'Murder',
 'Culpable homicide is murder if the act by which death is caused is done with the intention of causing death; or with the intention of causing such bodily injury as the offender knows to be likely to cause death; or with the intention of causing bodily injury sufficient in the ordinary course of nature to cause death; or with the knowledge that the act is so imminently dangerous that it must in all probability cause death. Five exceptions apply, including grave and sudden provocation and exceeding the right of private defence.',
 NULL, NULL, NULL, NULL, NULL,
 'BNS', '101', 'Chapter XVI - Of Offences Affecting the Human Body'),

('IPC', 'Indian Penal Code, 1860', '302', 'Punishment for murder',
 'Whoever commits murder shall be punished with death, or imprisonment for life, and shall also be liable to fine.',
 'Death or imprisonment for life, and fine', TRUE, FALSE, FALSE, 'Court of Session',
 'BNS', '103(1)', 'Chapter XVI - Of Offences Affecting the Human Body'),

('IPC', 'Indian Penal Code, 1860', '304', 'Punishment for culpable homicide not amounting to murder',
 'Where the act is done with the intention of causing death or such bodily injury as is likely to cause death: imprisonment for life, or imprisonment up to ten years, and fine. Where the act is done with the knowledge that it is likely to cause death but without any intention to cause death: imprisonment up to ten years, or fine, or both.',
 'Imprisonment for life or up to 10 years, and fine', TRUE, FALSE, FALSE, 'Court of Session',
 'BNS', '105', 'Chapter XVI - Of Offences Affecting the Human Body'),

('IPC', 'Indian Penal Code, 1860', '307', 'Attempt to murder',
 'Whoever does any act with such intention or knowledge and under such circumstances that, if he by that act caused death, he would be guilty of murder, shall be punished with imprisonment up to ten years and fine. If hurt is caused, the offender is liable to imprisonment for life or such punishment as mentioned above.',
 'Imprisonment up to 10 years and fine; life imprisonment if hurt is caused', TRUE, FALSE, FALSE, 'Court of Session',
 'BNS', '109', 'Chapter XVI - Of Offences Affecting the Human Body'),

('IPC', 'Indian Penal Code, 1860', '323', 'Punishment for voluntarily causing hurt',
 'Whoever, except in the case provided for by section 334, voluntarily causes hurt, shall be punished with imprisonment of either description for a term which may extend to one year, or with fine which may extend to one thousand rupees, or with both.',
 'Imprisonment up to 1 year, or fine up to Rs. 1,000, or both', FALSE, TRUE, TRUE, 'Any Magistrate',
 'BNS', '115(2)', 'Chapter XVI - Of Offences Affecting the Human Body'),

('IPC', 'Indian Penal Code, 1860', '354', 'Assault or criminal force to woman with intent to outrage her modesty',
 'Whoever assaults or uses criminal force to any woman, intending to outrage or knowing it to be likely that he will thereby outrage her modesty, shall be punished with imprisonment of either description for a term which shall not be less than one year but which may extend to five years, and shall also be liable to fine.',
 'Imprisonment of 1 to 5 years, and fine', TRUE, FALSE, FALSE, 'Any Magistrate',
 'BNS', '74', 'Chapter XVI - Of Offences Affecting the Human Body'),

('IPC', 'Indian Penal Code, 1860', '376', 'Punishment for rape',
 'Whoever, except in the cases provided for in sub-section (2), commits rape, shall be punished with rigorous imprisonment of either description for a term which shall not be less than ten years, but which may extend to imprisonment for life, and shall also be liable to fine. Sub-section (2) provides enhanced punishment for aggravated forms, including rape by a police officer, public servant, or person in a position of trust.',
 'Rigorous imprisonment not less than 10 years, extendable to life, and fine', TRUE, FALSE, FALSE, 'Court of Session',
 'BNS', '64', 'Chapter XVI - Of Offences Affecting the Human Body'),

('IPC', 'Indian Penal Code, 1860', '379', 'Punishment for theft',
 'Whoever commits theft shall be punished with imprisonment of either description for a term which may extend to three years, or with fine, or with both.',
 'Imprisonment up to 3 years, or fine, or both', TRUE, FALSE, TRUE, 'Any Magistrate',
 'BNS', '303(2)', 'Chapter XVII - Of Offences Against Property'),

('IPC', 'Indian Penal Code, 1860', '406', 'Punishment for criminal breach of trust',
 'Whoever commits criminal breach of trust shall be punished with imprisonment of either description for a term which may extend to three years, or with fine, or with both.',
 'Imprisonment up to 3 years, or fine, or both', TRUE, FALSE, TRUE, 'Any Magistrate',
 'BNS', '316(2)', 'Chapter XVII - Of Offences Against Property'),

('IPC', 'Indian Penal Code, 1860', '420', 'Cheating and dishonestly inducing delivery of property',
 'Whoever cheats and thereby dishonestly induces the person deceived to deliver any property to any person, or to make, alter or destroy the whole or any part of a valuable security, or anything which is signed or sealed and which is capable of being converted into a valuable security, shall be punished with imprisonment of either description for a term which may extend to seven years, and shall also be liable to fine.',
 'Imprisonment up to 7 years, and fine', TRUE, FALSE, TRUE, 'Magistrate of the First Class',
 'BNS', '318(4)', 'Chapter XVII - Of Offences Against Property'),

('IPC', 'Indian Penal Code, 1860', '498A', 'Husband or relative of husband of a woman subjecting her to cruelty',
 'Whoever, being the husband or the relative of the husband of a woman, subjects such woman to cruelty shall be punished with imprisonment for a term which may extend to three years and shall also be liable to fine. Cruelty means any wilful conduct likely to drive the woman to suicide or cause grave injury or danger to life, limb or health, or harassment with a view to coercing her or any person related to her to meet an unlawful demand for property or valuable security.',
 'Imprisonment up to 3 years, and fine', TRUE, FALSE, FALSE, 'Magistrate of the First Class',
 'BNS', '85', 'Chapter XXA - Of Cruelty by Husband or Relatives of Husband'),

('IPC', 'Indian Penal Code, 1860', '506', 'Punishment for criminal intimidation',
 'Whoever commits the offence of criminal intimidation shall be punished with imprisonment of either description for a term which may extend to two years, or with fine, or with both. If the threat is to cause death or grievous hurt, or to destroy property by fire, or to impute unchastity to a woman, the punishment may extend to seven years, or fine, or both.',
 'Imprisonment up to 2 years (up to 7 years for aggravated threats), or fine, or both', FALSE, TRUE, TRUE, 'Any Magistrate',
 'BNS', '351', 'Chapter XXII - Of Criminal Intimidation, Insult and Annoyance'),


-- ====================== BHARATIYA NYAYA SANHITA, 2023 =======================
-- Reverse-mapped entries so "what is BNS 103" resolves as readily as "IPC 302".

('BNS', 'Bharatiya Nyaya Sanhita, 2023', '103(1)', 'Punishment for murder',
 'Whoever commits murder shall be punished with death or imprisonment for life, and shall also be liable to fine. This provision replaces section 302 of the Indian Penal Code, 1860 with effect from 1 July 2024.',
 'Death or imprisonment for life, and fine', TRUE, FALSE, FALSE, 'Court of Session',
 'IPC', '302', 'Chapter VI - Of Offences Affecting the Human Body'),

('BNS', 'Bharatiya Nyaya Sanhita, 2023', '318(4)', 'Cheating and dishonestly inducing delivery of property',
 'Whoever cheats and thereby dishonestly induces the person deceived to deliver any property to any person, or to make, alter or destroy the whole or any part of a valuable security, shall be punished with imprisonment of either description for a term which may extend to seven years, and shall also be liable to fine. This provision replaces section 420 of the Indian Penal Code, 1860.',
 'Imprisonment up to 7 years, and fine', TRUE, FALSE, TRUE, 'Magistrate of the First Class',
 'IPC', '420', 'Chapter XVII - Of Offences Against Property'),

('BNS', 'Bharatiya Nyaya Sanhita, 2023', '85', 'Husband or relative of husband of a woman subjecting her to cruelty',
 'Whoever, being the husband or the relative of the husband of a woman, subjects such woman to cruelty shall be punished with imprisonment for a term which may extend to three years and shall also be liable to fine. This provision replaces section 498A of the Indian Penal Code, 1860.',
 'Imprisonment up to 3 years, and fine', TRUE, FALSE, FALSE, 'Magistrate of the First Class',
 'IPC', '498A', 'Chapter V - Of Offences Against Woman and Child'),

('BNS', 'Bharatiya Nyaya Sanhita, 2023', '64', 'Punishment for rape',
 'Whoever commits rape shall be punished with rigorous imprisonment of either description for a term which shall not be less than ten years, but which may extend to imprisonment for life, and shall also be liable to fine. This provision replaces section 376 of the Indian Penal Code, 1860.',
 'Rigorous imprisonment not less than 10 years, extendable to life, and fine', TRUE, FALSE, FALSE, 'Court of Session',
 'IPC', '376', 'Chapter V - Of Offences Against Woman and Child'),


-- =================== CODE OF CRIMINAL PROCEDURE, 1973 =======================
('CRPC', 'Code of Criminal Procedure, 1973', '41', 'When police may arrest without warrant',
 'Any police officer may without an order from a Magistrate and without a warrant arrest any person who commits a cognizable offence in his presence, or against whom a reasonable complaint has been made or credible information received that he has committed a cognizable offence punishable with imprisonment which may extend to seven years, provided the officer is satisfied that the arrest is necessary on one of the grounds specified, and records his reasons in writing.',
 NULL, NULL, NULL, NULL, NULL,
 'BNSS', '35', 'Chapter V - Arrest of Persons'),

('CRPC', 'Code of Criminal Procedure, 1973', '41A', 'Notice of appearance before police officer',
 'Where arrest is not required under section 41(1), the police officer shall issue a notice directing the person to appear before him. Where the person complies and continues to comply with the notice, he shall not be arrested unless the officer records reasons why arrest is necessary. Compliance with this section was made mandatory by the Supreme Court in Arnesh Kumar v. State of Bihar (2014) 8 SCC 273.',
 NULL, NULL, NULL, NULL, NULL,
 'BNSS', '35(3)', 'Chapter V - Arrest of Persons'),

('CRPC', 'Code of Criminal Procedure, 1973', '125', 'Order for maintenance of wives, children and parents',
 'If any person having sufficient means neglects or refuses to maintain his wife unable to maintain herself, his legitimate or illegitimate minor child, or his father or mother unable to maintain themselves, a Magistrate of the first class may order such person to make a monthly allowance for their maintenance. The proceeding is summary in nature and available irrespective of the religion of the parties.',
 NULL, NULL, NULL, NULL, 'Magistrate of the First Class',
 'BNSS', '144', 'Chapter IX - Order for Maintenance of Wives, Children and Parents'),

('CRPC', 'Code of Criminal Procedure, 1973', '154', 'Information in cognizable cases (FIR)',
 'Every information relating to the commission of a cognizable offence, if given orally to an officer in charge of a police station, shall be reduced to writing, read over to the informant, and signed by them, and the substance entered in a book kept for the purpose. A copy shall be given to the informant free of cost. Registration of an FIR is mandatory where the information discloses a cognizable offence, per Lalita Kumari v. Government of Uttar Pradesh (2014) 2 SCC 1.',
 NULL, NULL, NULL, NULL, NULL,
 'BNSS', '173', 'Chapter XII - Information to the Police and their Powers to Investigate'),

('CRPC', 'Code of Criminal Procedure, 1973', '156(3)', 'Magistrate may order investigation',
 'Any Magistrate empowered under section 190 may order an investigation into a cognizable offence. This is the remedy where the police refuse to register an FIR, and is ordinarily invoked after the complainant has exhausted the remedy under section 154(3).',
 NULL, NULL, NULL, NULL, 'Magistrate empowered under section 190',
 'BNSS', '175(3)', 'Chapter XII - Information to the Police and their Powers to Investigate'),

('CRPC', 'Code of Criminal Procedure, 1973', '161', 'Examination of witnesses by police',
 'Any police officer making an investigation may examine orally any person supposed to be acquainted with the facts and circumstances of the case. Such person is bound to answer truly all questions other than those which would have a tendency to expose him to a criminal charge, penalty or forfeiture. A statement recorded under this section is not signed by the person making it and is usable only for contradiction under section 145 of the Evidence Act.',
 NULL, NULL, NULL, NULL, NULL,
 'BNSS', '180', 'Chapter XII - Information to the Police and their Powers to Investigate'),

('CRPC', 'Code of Criminal Procedure, 1973', '164', 'Recording of confessions and statements',
 'A Metropolitan or Judicial Magistrate may record any confession or statement made in the course of an investigation. Before recording a confession the Magistrate must explain that the person is not bound to make it and that it may be used against him, and must satisfy himself that it is voluntary.',
 NULL, NULL, NULL, NULL, 'Metropolitan or Judicial Magistrate',
 'BNSS', '183', 'Chapter XII - Information to the Police and their Powers to Investigate'),

('CRPC', 'Code of Criminal Procedure, 1973', '173', 'Report of police officer on completion of investigation',
 'Every investigation shall be completed without unnecessary delay, and the officer in charge shall forward to the Magistrate a report in the prescribed form setting out the names of the parties, the nature of the information, and whether an offence appears to have been committed and by whom. This report is commonly called the charge sheet, or a final report where no offence is made out.',
 NULL, NULL, NULL, NULL, NULL,
 'BNSS', '193', 'Chapter XII - Information to the Police and their Powers to Investigate'),

('CRPC', 'Code of Criminal Procedure, 1973', '436', 'In what cases bail to be taken',
 'When a person accused of a bailable offence is arrested or detained without warrant and is prepared to give bail, such person shall be released on bail. Bail in a bailable offence is a matter of right, not of discretion.',
 NULL, NULL, NULL, NULL, NULL,
 'BNSS', '478', 'Chapter XXXIII - Provisions as to Bail and Bonds'),

('CRPC', 'Code of Criminal Procedure, 1973', '437', 'When bail may be taken in case of non-bailable offence',
 'A person accused of a non-bailable offence may be released on bail by a court other than the High Court or Court of Session, but not where there appear reasonable grounds for believing he is guilty of an offence punishable with death or imprisonment for life. Exceptions apply for a person under the age of sixteen, a woman, or a person who is sick or infirm.',
 NULL, NULL, NULL, NULL, NULL,
 'BNSS', '480', 'Chapter XXXIII - Provisions as to Bail and Bonds'),

('CRPC', 'Code of Criminal Procedure, 1973', '438', 'Direction for grant of bail to person apprehending arrest (anticipatory bail)',
 'Where a person has reason to believe that he may be arrested on an accusation of having committed a non-bailable offence, he may apply to the High Court or the Court of Session for a direction that in the event of arrest he shall be released on bail. The court considers the nature and gravity of the accusation, the antecedents of the applicant, and whether the accusation appears to have been made to injure or humiliate him.',
 NULL, NULL, NULL, NULL, 'High Court or Court of Session',
 'BNSS', '482', 'Chapter XXXIII - Provisions as to Bail and Bonds'),

('CRPC', 'Code of Criminal Procedure, 1973', '439', 'Special powers of High Court or Court of Session regarding bail',
 'A High Court or Court of Session may direct that any accused person in custody be released on bail, and may impose or set aside conditions. It may also direct that a person released on bail under Chapter XXXIII be arrested and committed to custody.',
 NULL, NULL, NULL, NULL, 'High Court or Court of Session',
 'BNSS', '483', 'Chapter XXXIII - Provisions as to Bail and Bonds'),

('CRPC', 'Code of Criminal Procedure, 1973', '482', 'Saving of inherent powers of High Court',
 'Nothing in this Code shall be deemed to limit or affect the inherent powers of the High Court to make such orders as may be necessary to give effect to any order under this Code, or to prevent abuse of the process of any court, or otherwise to secure the ends of justice. This is the provision under which criminal proceedings are quashed.',
 NULL, NULL, NULL, NULL, 'High Court',
 'BNSS', '528', 'Chapter XXXVII - Miscellaneous'),


-- ======================= INDIAN EVIDENCE ACT, 1872 ==========================
('IEA', 'Indian Evidence Act, 1872', '65B', 'Admissibility of electronic records',
 'Any information contained in an electronic record which is printed on paper, stored, recorded or copied in optical or magnetic media produced by a computer shall be deemed to be a document and admissible without further proof of the original, provided the conditions in sub-section (2) are satisfied and a certificate under sub-section (4) is furnished. The certificate is mandatory for electronic evidence produced from a device not in the party''s lawful control, per Arjun Panditrao Khotkar v. Kailash Kushanrao Gorantyal (2020) 7 SCC 1.',
 NULL, NULL, NULL, NULL, NULL,
 'BSA', '63', 'Chapter V - Of Documentary Evidence')

ON CONFLICT (act_code, section_number, language) DO NOTHING;
